import { FadenApiError, FadenError, FadenSignInRequiredError, FadenUnreachableError } from "../errors.js";
import { toApiError } from "../http/errorReader.js";
import { requireSecureUrl, type FetchLike } from "../http/transport.js";

/** An agent sign-in on one device: a short access token and the refresh token that renews it. Times in ms since the epoch. */
export interface TokenSet {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  /** This device's sign-in; the server lists and revokes sign-ins by it. */
  deviceId: string;
  agentId: string;
  agent: string;
}

/** Where a client's access tokens come from. */
export interface TokenProvider {
  /** A token valid now. Refreshes when it has to. */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /** The server refused the last token (401): the next call must not reuse it. */
  invalidate(rejectedToken: string): Promise<void>;
}

/** A fixed token: an API token for the plain routes, or a user's login token for tests and tools. */
export class StaticTokenProvider implements TokenProvider {
  readonly #token: string;

  constructor(token: string) {
    if (!token?.trim()) throw new TypeError("A token is required.");
    this.#token = token;
  }

  getAccessToken(): Promise<string> {
    return Promise.resolve(this.#token);
  }

  invalidate(): Promise<void> {
    return Promise.resolve();
  }
}

/** Keeps an agent's sign-in between runs. A browser extension keeps it in `chrome.storage`, a desktop app in a file. */
export interface TokenStore {
  load(key: string): Promise<TokenSet | undefined>;
  save(key: string, tokens: TokenSet): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Only in memory: a sign-in lasts as long as the page or process. */
export class MemoryTokenStore implements TokenStore {
  readonly #tokens = new Map<string, TokenSet>();

  load(key: string): Promise<TokenSet | undefined> {
    return Promise.resolve(this.#tokens.get(key));
  }

  save(key: string, tokens: TokenSet): Promise<void> {
    this.#tokens.set(key, { ...tokens });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#tokens.delete(key);
    return Promise.resolve();
  }
}

/** Renew this long before the access token expires. */
const EARLY_MS = 30_000;

/** How long a refresh may take. */
const REFRESH_TIMEOUT_MS = 30_000;

/** `promise`, or the signal's reason once it aborts (the promise itself goes on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface AgentTokenProviderOptions {
  /** The backend (usually the server URL). */
  apiUrl: string | URL;
  /** The agent's slug or id. */
  agent: string;
  /** Where the sign-in is kept; in memory by default. */
  store?: TokenStore;
  fetch?: FetchLike;
  /** The time, for tests. */
  now?: () => number;
  /** Allow `http://` to another machine. Off: tokens go over https, or plain http only to this machine. */
  allowInsecureHttp?: boolean;
}

/**
 * An agent sign-in on this device: a short access token for one agent, renewed with a refresh token the server
 * replaces on every use. Kept in a `TokenStore` between runs. Concurrent callers share one refresh.
 */
export class AgentTokenProvider implements TokenProvider {
  readonly agent: string;
  readonly #apiUrl: URL;
  readonly #store: TokenStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #key: string;
  #tokens: TokenSet | undefined;
  #loaded = false;
  #refreshing: Promise<TokenSet> | undefined;

  constructor(options: AgentTokenProviderOptions) {
    const base = requireSecureUrl(options.apiUrl, "apiUrl", options.allowInsecureHttp);
    this.#apiUrl = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
    this.agent = options.agent;
    this.#store = options.store ?? new MemoryTokenStore();
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#key = AgentTokenProvider.storeKey(this.#apiUrl, options.agent);
  }

  /** The key a sign-in is kept under: the backend and the agent. */
  static storeKey(apiUrl: string | URL, agent: string): string {
    const base = new URL(apiUrl).href.replace(/\/?$/, "/");
    return `${base}|${agent}`;
  }

  /** The device's sign-in id, once signed in (or loaded). */
  get deviceId(): string | undefined {
    return this.#tokens?.deviceId;
  }

  /**
   * Signs in to the agent with the user's login token (from `loginWithPassword`, or the organisation's single
   * sign-on). Refused with 403 when the user has no grant. The login token itself is not kept.
   */
  async signIn(loginToken: string, deviceLabel?: string, signal?: AbortSignal): Promise<TokenSet> {
    const body: Record<string, unknown> = { agent: this.agent };
    if (deviceLabel) body["device_label"] = deviceLabel.slice(0, 200);
    const tokens = await this.#issue("api/agent-tokens", body, loginToken, signal);
    await this.#remember(tokens);
    return tokens;
  }

  /** Whether a sign-in is kept that can still be renewed. */
  async isSignedIn(): Promise<boolean> {
    const tokens = await this.#current();
    return tokens !== undefined && tokens.refreshExpiresAt > this.#now();
  }

  /**
   * Forgets the sign-in on this device. (Ending it on the server: the user's sign-ins in the console, or
   * `DELETE /api/agent-tokens/{device}` with their login.)
   */
  async signOut(): Promise<void> {
    this.#tokens = undefined;
    this.#loaded = true;
    await this.#store.delete(this.#key);
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const current = await this.#current();
    if (current && current.accessExpiresAt - EARLY_MS > this.#now()) return current.accessToken;
    // One refresh for every caller, under its own time limit: one caller giving up does not fail the others.
    this.#refreshing ??= this.#refresh(current).finally(() => {
      this.#refreshing = undefined;
    });
    const tokens = await (signal ? abortable(this.#refreshing, signal) : this.#refreshing);
    return tokens.accessToken;
  }

  invalidate(rejectedToken: string): Promise<void> {
    if (this.#tokens && this.#tokens.accessToken === rejectedToken) {
      this.#tokens = { ...this.#tokens, accessExpiresAt: this.#now() - 60_000 };
    }
    return Promise.resolve();
  }

  async #refresh(current: TokenSet | undefined): Promise<TokenSet> {
    if (!current || current.refreshExpiresAt <= this.#now()) {
      throw new FadenSignInRequiredError(`Sign in to the agent '${this.agent}' on this device.`);
    }
    let renewed: TokenSet;
    try {
      renewed = await this.#issue("api/agent-tokens/refresh", { refresh_token: current.refreshToken }, undefined,
        AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof FadenApiError && (error.status === 401 || error.status === 403)) {
        // Revoked, reused elsewhere (the whole sign-in ended), or the user lost access.
        await this.signOut();
        throw new FadenSignInRequiredError(`The sign-in to '${this.agent}' ended: ${error.message}`, { cause: error });
      }
      throw error;
    }
    await this.#remember(renewed);
    return renewed;
  }

  async #current(): Promise<TokenSet | undefined> {
    if (!this.#loaded) {
      this.#tokens = await this.#store.load(this.#key);
      this.#loaded = true;
    }
    return this.#tokens;
  }

  async #remember(tokens: TokenSet): Promise<void> {
    this.#tokens = tokens;
    this.#loaded = true;
    await this.#store.save(this.#key, tokens);
  }

  async #issue(path: string, body: unknown, bearer: string | undefined, signal?: AbortSignal): Promise<TokenSet> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (bearer) headers["authorization"] = `Bearer ${bearer}`;
    let response: Response;
    try {
      const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body), credentials: "omit" };
      if (signal) init.signal = signal;
      response = await this.#fetch(new URL(path, this.#apiUrl), init);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new FadenUnreachableError(`Fadenstack could not be reached: ${(error as Error).message}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) throw toApiError(response, text);
    const issued = JSON.parse(text) as Record<string, unknown>;
    const now = this.#now();
    return {
      accessToken: String(issued["access_token"] ?? ""),
      accessExpiresAt: now + Number(issued["expires_in"] ?? 0) * 1000,
      refreshToken: String(issued["refresh_token"] ?? ""),
      refreshExpiresAt: now + Number(issued["refresh_expires_in"] ?? 0) * 1000,
      deviceId: String(issued["device_id"] ?? ""),
      agentId: String(issued["agent_id"] ?? ""),
      agent: String(issued["agent"] ?? this.agent),
    };
  }
}

export interface PasswordLoginOptions {
  apiUrl: string | URL;
  email: string;
  password: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Allow `http://` to another machine (a development server). Off: the password goes over https only. */
  allowInsecureHttp?: boolean;
}

/**
 * The user's login token from their e-mail and password (`POST /api/auth/jwt/login`), to sign in to agents
 * with. Keep it only as long as the sign-in takes.
 */
export async function loginWithPassword(options: PasswordLoginOptions): Promise<string> {
  const base = requireSecureUrl(options.apiUrl, "apiUrl", options.allowInsecureHttp);
  const url = new URL("api/auth/jwt/login", base.href.endsWith("/") ? base : `${base.href}/`);
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: options.email, password: options.password }).toString(),
    };
    if (options.signal) init.signal = options.signal;
    response = await fetchImpl(url, init);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new FadenUnreachableError(`Fadenstack could not be reached: ${(error as Error).message}`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 400 && text.includes("LOGIN_BAD_CREDENTIALS")) {
      throw new FadenApiError(400, "The e-mail or password is not right.", { code: "LOGIN_BAD_CREDENTIALS" });
    }
    throw toApiError(response, text);
  }
  let token: unknown;
  try {
    token = (JSON.parse(text) as Record<string, unknown>)["access_token"];
  } catch {
    // A web page where the API should be: another server, or a path in front of Fadenstack's.
    throw new FadenApiError(response.status, "This address does not answer like a Fadenstack server.", { code: "not_fadenstack" });
  }
  if (typeof token !== "string" || !token) throw new FadenError("The server gave no login token.");
  return token;
}
