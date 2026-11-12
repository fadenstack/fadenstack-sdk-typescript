import { FadenstackError, FadenstackUnreachableError } from "../errors.js";
import { toApiError, retryAfterMs } from "../http/errorReader.js";
import { requireSecureUrl, type FetchLike } from "../http/transport.js";
import { ClientLog, writeLog, type FadenstackLogger } from "../logging.js";
import { AgentTokenProvider, MemoryTokenStore, readTokenSet, type SignedInUser, type TokenStore } from "./tokens.js";

/** What the app says about itself when it asks for a pairing. The approval page shows it as the app's own word. */
export interface PairingClient {
  /** The app's name, e.g. "Browser assistant". */
  name: string;
  version: string;
  /** The operating system or browser, e.g. "Windows 11" or "Chrome 140". */
  os: string;
}

/**
 * An agent's tokens cannot be had from this pairing. `reason` says why: `not_approved_or_redeemed` (the server answered
 * `invalid_grant`: the person did not approve this agent, or its tokens were collected already), `pending` (nobody has
 * approved yet), or `not_offered` (the server ignored the further agents when the pairing started, so only the first is
 * on offer; nothing was sent).
 */
export class FadenstackPairingAgentError extends FadenstackError {
  readonly agent: string;
  readonly reason: "not_approved_or_redeemed" | "pending" | "not_offered";
  constructor(agent: string, reason: FadenstackPairingAgentError["reason"], message: string) {
    super(message);
    this.agent = agent;
    this.reason = reason;
  }
}

/** The most agents one pairing can name, the first included. */
export const MAX_PAIRING_AGENTS = 8;

/** The person denied the pairing in the console. */
export class FadenstackPairingDeniedError extends FadenstackError {}
/** The code expired before it was approved, or the server no longer knows it. Start a new pairing. */
export class FadenstackPairingExpiredError extends FadenstackError {}
/** The server has no pairing routes (404, or 405 from core 0.7.0): it is older than this feature. */
export class FadenstackPairingUnsupportedError extends FadenstackError {}

// The secret the app polls with lives here, apart from the object the app shows: never a property, never in JSON or text.
const codes = new WeakMap<PairingStart, string>();

/**
 * A pairing the server started: what to show the person. The pairing code the app polls with stays inside; it is not a
 * property and not in `toString()` or `toJSON()`.
 */
export class PairingStart {
  /** The first agent: the one `wait` returns tokens for unless told otherwise. */
  readonly agent: string;
  /**
   * The agents the server stored for this pairing, in order (the first is `agent`). Empty when the server ignored the
   * `agents` the app asked for or does not know them: then only `agent` can be redeemed, see `ignoredAgents`.
   */
  readonly agents: readonly string[];
  /** Agents the app asked for that the server did not store (an older server): their tokens cannot be had from this pairing. */
  readonly ignoredAgents: readonly string[];
  /** The short code to show, e.g. `BDWP-HTQX`; the person compares it in the console. Show it, do not log it. */
  readonly userCode: string;
  /** The console page where the person enters the code; always on the server's own origin. */
  readonly verificationUri: URL;
  /** The same page with the code filled in (in the fragment, which no server sees): open this in the browser. Opening it approves nothing. */
  readonly verificationUriComplete: URL;
  /** When the code expires, in ms since the epoch (the server's lifetime, counted on this device's clock). */
  readonly expiresAt: number;
  /** How often the server wants to be asked, in ms. */
  readonly intervalMs: number;

  /** @internal */
  constructor(agent: string, agents: readonly string[], ignoredAgents: readonly string[], pairingCode: string, userCode: string, uri: URL,
    complete: URL, expiresAt: number, intervalMs: number) {
    this.agent = agent;
    this.agents = agents;
    this.ignoredAgents = ignoredAgents;
    this.userCode = userCode;
    this.verificationUri = uri;
    this.verificationUriComplete = complete;
    this.expiresAt = expiresAt;
    this.intervalMs = intervalMs;
    codes.set(this, pairingCode);
  }

  /** No code: only that this is a pairing and when it ends. */
  toString(): string {
    return `PairingStart(expires ${new Date(this.expiresAt).toISOString()})`;
  }

  toJSON(): { expiresAt: number } {
    return { expiresAt: this.expiresAt };
  }
}

/** Where a wait for approval stands. */
export type PairingState = "waiting" | "slowed_down" | "retrying";

/** Reported while waiting, after every poll. */
export interface PairingProgress {
  /** What the last poll found: `waiting` (not decided yet), `slowed_down` (the interval grew), `retrying` (the server could not be reached). */
  state: PairingState;
  /** How long the code is still valid (never negative), in ms. */
  timeLeftMs: number;
  /** The wait between polls now, in ms. */
  intervalMs: number;
}

/** A finished pairing: the sign-in is saved in the store. */
export interface PairingResult {
  /** The agent the person signed in to. */
  agentSlug: string;
  /** Agents the app asked for that this pairing cannot give (an older server ignored them); absent otherwise. */
  ignoredAgents?: readonly string[];
  /** This device's sign-in; the server lists and revokes sign-ins by it. */
  deviceId: string;
  /** Who approved it; undefined if the server did not say. */
  signedInUser?: SignedInUser;
}

export interface AgentPairingOptions {
  /** The backend (usually the server URL); the same one the `AgentTokenProvider` gets. */
  apiUrl: string | URL;
  /** Where the sign-in is kept: the one the `AgentTokenProvider` uses. In memory by default. */
  store?: TokenStore;
  fetch?: FetchLike;
  /** The time, in ms since the epoch, for tests. */
  now?: () => number;
  /** How to wait between polls, for tests; a timer (stopped by the signal) by default. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Allow `http://` to another machine, for a development server. Off: https, or plain http only to this machine. */
  allowInsecureHttp?: boolean;
  /** Where progress is logged (no code, no token, never who signed in). None by default. */
  logger?: FadenstackLogger;
}

export interface PairingStartOptions {
  /** The further agents, after the first (`start`'s `agent`): at most 7, no repeats, none equal to the first. One approval covers all. */
  agents?: readonly string[];
  signal?: AbortSignal;
}

export interface PairingWaitOptions {
  /** Which agent's tokens to return; the first agent by default. Must be one the server stored (`PairingStart.agents`). */
  agent?: string;
  /** Told the state and the time left after every poll. */
  onProgress?: (progress: PairingProgress) => void;
  /** Stops the wait; the pairing stays valid at the server until it expires. */
  signal?: AbortSignal;
}

const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];
const SLOW_DOWN_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Signs a person in to one agent on this device by pairing (the OAuth 2.0 Device Authorization Grant, RFC 8628): the app
 * shows a short code, the person approves it in the web console in their browser -- where they sign in however the server
 * lets them, including SSO and MFA -- and the app then receives the same agent tokens a sign-in issues. The app never sees
 * a password. `start` asks for a pairing; show `userCode` and open `verificationUriComplete` (`openInBrowser`, from
 * `@fadenstack/agents`). `wait` polls until the person approves or denies it, or it expires, and saves the tokens to the
 * store. An `AgentTokenProvider` for the same server, agent and store is signed in afterwards.
 *
 * The pairing code (the secret the app polls with) is held in memory, apart from `PairingStart`'s properties, and is never
 * stored, logged, put in an error or printed. A server that names a page on another origin than its own is refused:
 * nothing is shown and nothing opened (OWASP ASVS 5.0 V3.7). .NET: `Fadenstack.Auth.AgentPairing`.
 */
export class AgentPairing {
  readonly #api: URL;
  readonly #store: TokenStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #logger: FadenstackLogger | undefined;

  constructor(options: AgentPairingOptions) {
    const base = requireSecureUrl(options.apiUrl, "apiUrl", options.allowInsecureHttp);
    this.#api = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
    this.#store = options.store ?? new MemoryTokenStore();
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? sleep;
    this.#logger = options.logger;
  }

  /**
   * Asks the server for a pairing for `agent` on this device. Show the returned code and open its link.
   * @param deviceLabel Names the sign-in in the person's list of sign-ins, e.g. "Browser assistant on Chrome".
   * @throws FadenstackPairingUnsupportedError The server is older than this feature (404, or 405 from core 0.7.0).
   * @throws FadenstackRateLimitedError Too many pairings were started from this address (429).
   */
  async start(agent: string, deviceLabel: string, client: PairingClient, options?: AbortSignal | PairingStartOptions): Promise<PairingStart> {
    const { agents: further = [], signal } = options instanceof AbortSignal ? { signal: options } : options ?? {};
    const all = [agent, ...further];
    if (all.length > MAX_PAIRING_AGENTS) throw new RangeError(`A pairing names at most ${MAX_PAIRING_AGENTS} agents.`);
    if (all.some((a) => typeof a !== "string" || !a)) throw new TypeError("Every agent of a pairing needs a name.");
    if (new Set(all).size !== all.length) throw new TypeError("An agent can be named only once in a pairing.");
    // one agent: the body is what it always was
    const { response, text } = await this.#send("api/agent-tokens/pairings",
      { agent, ...(further.length > 0 ? { agents: all } : {}), device_label: deviceLabel,
        client: { name: client.name, version: client.version, os: client.os } }, signal);
    if (tooOld(response.status)) {
      writeLog(this.#logger, ClientLog.pairingEnded, { Agent: agent, Outcome: "unsupported" });
      throw unsupported();
    }
    if (!response.ok) throw toApiError(response, text);
    let started: Record<string, unknown>;
    try {
      started = JSON.parse(text) as Record<string, unknown>;
    } catch {
      started = {};
    }
    const pairingCode = started["pairing_code"], userCode = started["user_code"];
    if (typeof pairingCode !== "string" || !pairingCode || typeof userCode !== "string" || !userCode) {
      throw new FadenstackError("The server's answer to the pairing request was not understood.");
    }
    const uri = this.#page(started["verification_uri"]);
    const complete = typeof started["verification_uri_complete"] === "string" && started["verification_uri_complete"]
      ? this.#page(started["verification_uri_complete"])
      : this.#page(`${uri.href.split("#")[0]}#code=${encodeURIComponent(userCode)}`);
    const expiresIn = typeof started["expires_in"] === "number" && started["expires_in"] > 0 ? started["expires_in"] : 600;
    const interval = typeof started["interval"] === "number" ? Math.max(1, started["interval"]) : 5;
    const stored = Array.isArray(started["agents"]) ? (started["agents"] as unknown[]).filter((a): a is string => typeof a === "string") : [];
    const offered = stored.length > 0 ? stored : [agent];
    const ignored = further.filter((a) => !offered.includes(a));
    writeLog(this.#logger, ClientLog.pairingStarted, { Agent: agent, ExpiresInS: expiresIn });
    return new PairingStart(agent, stored, ignored, pairingCode, userCode, uri, complete, this.#now() + expiresIn * 1000, interval * 1000);
  }

  /**
   * Polls until the person approves or denies the pairing, or it expires, and saves the tokens and who signed in to the store.
   * It waits the server's interval between polls, five seconds longer each time the server says `slow_down`, and when the
   * server cannot be reached it tries again after 5, 10, 20 and then 30 seconds for as long as the pairing is valid.
   * @throws FadenstackPairingDeniedError The person denied the pairing in the console.
   * @throws FadenstackPairingExpiredError The code expired, or the server no longer knows it.
   * @throws FadenstackPairingUnsupportedError The server does not have the pairing routes.
   */
  async wait(start: PairingStart, options: PairingWaitOptions = {}): Promise<PairingResult> {
    const { signal, onProgress } = options;
    const pairingCode = codes.get(start);
    if (pairingCode === undefined) throw new TypeError("Wait for a pairing that start() returned.");
    const agent = this.#offered(start, options.agent);
    let interval = start.intervalMs;
    let wait = interval;
    let failures = 0;
    const report = (state: PairingState) =>
      onProgress?.({ state, timeLeftMs: Math.max(0, start.expiresAt - this.#now()), intervalMs: interval });
    report("waiting");
    for (;;) {
      await this.#delay(wait, signal);
      signal?.throwIfAborted();
      if (this.#now() >= start.expiresAt) throw this.#expired(start, "The code expired.");
      let answer: { response: Response; text: string };
      try {
        answer = await this.#send("api/agent-tokens/pairings/token", tokenBody(start, pairingCode, agent), signal);
      } catch (error) {
        if (!(error instanceof FadenstackUnreachableError)) throw error;
        wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        writeLog(this.#logger, ClientLog.pairingRetrying, { Agent: start.agent, Reason: "network", WaitS: wait / 1000 });
        report("retrying");
        continue;
      }
      const { response, text } = answer;
      if (response.ok) return this.#finish(start, agent, text);
      if (response.status >= 500) {
        wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        writeLog(this.#logger, ClientLog.pairingRetrying, { Agent: start.agent, Reason: `status ${response.status}`, WaitS: wait / 1000 });
        report("retrying");
        continue;
      }
      failures = 0;
      let state: PairingState = "waiting";
      switch (response.status === 429 ? "slow_down" : errorCode(text)) {
        case "authorization_pending":
          break;
        case "slow_down": {
          interval += SLOW_DOWN_MS;
          const retryAfter = retryAfterMs(response.headers, this.#now());
          if (retryAfter !== undefined && retryAfter > interval) interval = retryAfter;
          state = "slowed_down";
          writeLog(this.#logger, ClientLog.pairingSlowedDown, { Agent: start.agent, IntervalS: Math.round(interval / 1000) });
          break;
        }
        case "access_denied":
          writeLog(this.#logger, ClientLog.pairingEnded, { Agent: start.agent, Outcome: "denied" });
          throw new FadenstackPairingDeniedError("The sign-in was denied in the browser.");
        case "expired_token":
          throw this.#expired(start, "The code expired.");
        case "invalid_grant":
          throw this.#expired(start, "The server no longer knows this code. Get a new one.");
        default:
          if (tooOld(response.status)) throw unsupported();
          throw toApiError(response, text);
      }
      wait = interval;
      report(state);
    }
  }

  /**
   * Collects another listed agent's tokens after the approval: one request, no waiting, and the tokens are saved for that agent.
   * @throws FadenstackPairingAgentError Not approved yet (`pending`), not approved for this agent or already collected
   *   (`not_approved_or_redeemed`, the server's `invalid_grant`), or never on offer (`not_offered`, nothing sent).
   * @throws FadenstackPairingDeniedError The person denied the pairing.
   * @throws FadenstackPairingExpiredError The code expired.
   */
  async redeem(start: PairingStart, agent: string, signal?: AbortSignal): Promise<PairingResult> {
    const pairingCode = codes.get(start);
    if (pairingCode === undefined) throw new TypeError("Redeem a pairing that start() returned.");
    this.#offered(start, agent);
    const { response, text } = await this.#send("api/agent-tokens/pairings/token", tokenBody(start, pairingCode, agent), signal);
    if (response.ok) return this.#finish(start, agent, text);
    switch (response.status === 429 ? "slow_down" : errorCode(text)) {
      case "invalid_grant":
        writeLog(this.#logger, ClientLog.pairingEnded, { Agent: agent, Outcome: "not redeemable" });
        throw new FadenstackPairingAgentError(agent, "not_approved_or_redeemed",
          `The sign-in for agent ${agent} cannot be collected: the person did not approve it, or it was collected already.`);
      case "authorization_pending":
      case "slow_down":
        throw new FadenstackPairingAgentError(agent, "pending", "The person has not approved the pairing yet.");
      case "access_denied":
        throw new FadenstackPairingDeniedError("The sign-in was denied in the browser.");
      case "expired_token":
        throw this.#expired(start, "The code expired.");
      default:
        if (tooOld(response.status)) throw unsupported();
        throw toApiError(response, text);
    }
  }

  /** The agent to get tokens for: the first by default; one the server did not store (an older server) is refused before any request. */
  #offered(start: PairingStart, agent: string | undefined): string {
    if (agent === undefined || agent === start.agent) return start.agent;
    if (!start.agents.includes(agent)) {
      throw new FadenstackPairingAgentError(agent, "not_offered", start.ignoredAgents.includes(agent)
        ? `The server did not take agent ${agent} into this pairing (it is older than several agents per pairing). Pair for it separately.`
        : `Agent ${agent} is not part of this pairing.`);
    }
    return agent;
  }

  async #finish(start: PairingStart, agent: string, text: string): Promise<PairingResult> {
    let tokens;
    try {
      tokens = readTokenSet(JSON.parse(text) as Record<string, unknown>, this.#now(), agent);
    } catch {
      throw new FadenstackError("The server's sign-in answer was not understood.");
    }
    if (!tokens.accessToken || !tokens.refreshToken) throw new FadenstackError("The server's sign-in answer was not understood.");
    await this.#store.save(AgentTokenProvider.storeKey(this.#api, agent), tokens);
    writeLog(this.#logger, ClientLog.pairingEnded, { Agent: agent, Outcome: "signed in" });
    return { agentSlug: tokens.agent || agent, ...(start.ignoredAgents.length > 0 ? { ignoredAgents: start.ignoredAgents } : {}), deviceId: tokens.deviceId, ...(tokens.user ? { signedInUser: tokens.user } : {}) };
  }

  #expired(start: PairingStart, message: string): FadenstackPairingExpiredError {
    writeLog(this.#logger, ClientLog.pairingEnded, { Agent: start.agent, Outcome: "expired" });
    return new FadenstackPairingExpiredError(message);
  }

  /** One POST; a request that gets no answer is a `FadenstackUnreachableError` (whose cause names why). */
  async #send(path: string, body: unknown, signal?: AbortSignal): Promise<{ response: Response; text: string }> {
    const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(new URL(path, this.#api), {
        method: "POST", credentials: "omit", signal: signal ? AbortSignal.any([signal, limit]) : limit,
        headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
      });
      return { response, text: await response.text() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // The message of a network error can carry the address; the caller sees it, a log would not.
      throw new FadenstackUnreachableError(`Fadenstack could not be reached: ${(error as Error).message}`, { cause: error });
    }
  }

  /** A page the server names, on the server's own origin and nowhere else (the address may be relative). */
  #page(address: unknown): URL {
    let url: URL;
    try {
      url = new URL(String(address), this.#api);
    } catch {
      throw new FadenstackError("The server's sign-in address is not a web address.");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.origin !== this.#api.origin) {
      throw new FadenstackError("The pairing page is not on the server's own address.");
    }
    return url;
  }
}

/** The token request: the code, and the agent only when it is not the first (the wire of one agent stays what it was). */
function tokenBody(start: PairingStart, pairingCode: string, agent: string): Record<string, string> {
  return agent === start.agent ? { pairing_code: pairingCode } : { pairing_code: pairingCode, agent };
}

/** A server older than pairing: no route (404), or a route of the same path for another method (405, as core 0.7.0 answers). */
function tooOld(status: number): boolean {
  return status === 404 || status === 405;
}

function unsupported(): FadenstackPairingUnsupportedError {
  return new FadenstackPairingUnsupportedError("This server does not support signing in by pairing yet. Ask your IT to update Fadenstack.");
}

/** The RFC 8628 error code of an error body: `{"error": ...}`, or `code` / `detail.code` / `error.code`. */
function errorCode(body: string): string | undefined {
  try {
    const root = JSON.parse(body.trim() === "" ? "{}" : body) as unknown;
    if (root === null || typeof root !== "object" || Array.isArray(root)) return undefined;
    for (const name of ["code", "error", "detail"]) {
      const found = (root as Record<string, unknown>)[name];
      if (typeof found === "string") return found;
      if (found !== null && typeof found === "object" && typeof (found as Record<string, unknown>)["code"] === "string") {
        return (found as Record<string, string>)["code"];
      }
    }
  } catch {
    // not JSON: the status says it
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

