import { FadenstackError, FadenstackUnreachableError } from "../errors.js";
import { toApiError, retryAfterMs } from "../http/errorReader.js";
import { requireSecureUrl, type FetchLike } from "../http/transport.js";
import { AgentTokenProvider, MemoryTokenStore, readTokenSet, type SignedInUser, type TokenStore } from "./tokens.js";

/** What the app says about itself when it asks for a pairing. The approval page shows it as the app's own word. */
export interface PairingClient {
  /** The app's name, e.g. "Browser assistant". */
  name: string;
  version: string;
  /** The operating system or browser, e.g. "Windows 11" or "Chrome 140". */
  os: string;
}

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
  /** @internal */
  readonly agent: string;
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
  constructor(agent: string, pairingCode: string, userCode: string, uri: URL, complete: URL, expiresAt: number, intervalMs: number) {
    this.agent = agent;
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
}

export interface PairingWaitOptions {
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

  constructor(options: AgentPairingOptions) {
    const base = requireSecureUrl(options.apiUrl, "apiUrl", options.allowInsecureHttp);
    this.#api = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
    this.#store = options.store ?? new MemoryTokenStore();
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? sleep;
  }

  /**
   * Asks the server for a pairing for `agent` on this device. Show the returned code and open its link.
   * @param deviceLabel Names the sign-in in the person's list of sign-ins, e.g. "Browser assistant on Chrome".
   * @throws FadenstackPairingUnsupportedError The server is older than this feature (404, or 405 from core 0.7.0).
   * @throws FadenstackRateLimitedError Too many pairings were started from this address (429).
   */
  async start(agent: string, deviceLabel: string, client: PairingClient, signal?: AbortSignal): Promise<PairingStart> {
    const { response, text } = await this.#send("api/agent-tokens/pairings",
      { agent, device_label: deviceLabel, client: { name: client.name, version: client.version, os: client.os } }, signal);
    if (tooOld(response.status)) throw unsupported();
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
    return new PairingStart(agent, pairingCode, userCode, uri, complete, this.#now() + expiresIn * 1000, interval * 1000);
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
    let interval = start.intervalMs;
    let wait = interval;
    let failures = 0;
    const report = (state: PairingState) =>
      onProgress?.({ state, timeLeftMs: Math.max(0, start.expiresAt - this.#now()), intervalMs: interval });
    report("waiting");
    for (;;) {
      await this.#delay(wait, signal);
      signal?.throwIfAborted();
      if (this.#now() >= start.expiresAt) throw new FadenstackPairingExpiredError("The code expired.");
      let answer: { response: Response; text: string };
      try {
        answer = await this.#send("api/agent-tokens/pairings/token", { pairing_code: pairingCode }, signal);
      } catch (error) {
        if (!(error instanceof FadenstackUnreachableError)) throw error;
        wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        report("retrying");
        continue;
      }
      const { response, text } = answer;
      if (response.ok) return this.#finish(start, text);
      if (response.status >= 500) {
        wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
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
          break;
        }
        case "access_denied":
          throw new FadenstackPairingDeniedError("The sign-in was denied in the browser.");
        case "expired_token":
          throw new FadenstackPairingExpiredError("The code expired.");
        case "invalid_grant":
          throw new FadenstackPairingExpiredError("The server no longer knows this code. Get a new one.");
        default:
          if (tooOld(response.status)) throw unsupported();
          throw toApiError(response, text);
      }
      wait = interval;
      report(state);
    }
  }

  async #finish(start: PairingStart, text: string): Promise<PairingResult> {
    let tokens;
    try {
      tokens = readTokenSet(JSON.parse(text) as Record<string, unknown>, this.#now(), start.agent);
    } catch {
      throw new FadenstackError("The server's sign-in answer was not understood.");
    }
    if (!tokens.accessToken || !tokens.refreshToken) throw new FadenstackError("The server's sign-in answer was not understood.");
    await this.#store.save(AgentTokenProvider.storeKey(this.#api, start.agent), tokens);
    return { agentSlug: tokens.agent || start.agent, deviceId: tokens.deviceId, ...(tokens.user ? { signedInUser: tokens.user } : {}) };
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

