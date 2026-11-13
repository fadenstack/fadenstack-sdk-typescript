import type { TokenProvider } from "../auth/tokens.js";
import { FadenstackError, FadenstackUnreachableError } from "../errors.js";
import { ClientLog, writeLog, type FadenstackLogger } from "../logging.js";
import { toApiError } from "./errorReader.js";

/** A `fetch` -- the global one, a test's, or one with the host's own settings. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What the transport needs to reach a server, and as whom. */
export interface TransportOptions {
  /** The Fadenstack server. The gateway's `/v1` routes are under it; so is the backend's `/api`, unless `apiUrl` says otherwise. */
  serverUrl: string | URL;
  /** The backend (sign-in, agent tokens), when it is not at `serverUrl`. */
  apiUrl?: string | URL;
  /** Where access tokens come from: an API token, or an agent sign-in (`AgentTokenProvider`). */
  credentials?: TokenProvider;
  /** Allow `http://`. Off: agents use TLS. Only for a development server on this machine. */
  allowInsecureHttp?: boolean;
  /** The `fetch` to use; the global one by default. */
  fetch?: FetchLike;
  /** How long one request may take, in ms (default 5 min). A stream is not cut by it once its answer started. */
  timeoutMs?: number;
  /** Where the client logs (method, route, status, time; never a body, a header or a token). None by default. */
  logger?: FadenstackLogger;
}

/** The header a client announces what it can do beyond the agent API it was written for (sdk/40 §3 rule 5). */
export const CLIENT_SUPPORTS_HEADER = "X-Faden-Client-Supports";

/**
 * What an agent announces once it has the whole flow of the server's Bypass: the confirmation, the grant, the marker,
 * the report at the end of each turn (`tool_mode.bypass`) and the second sign-in in the browser before it is switched
 * on (`bypass.step_up`). The server offers Bypass only to a client that names both, so announce them only together with
 * that flow (`FadenstackTransport.announce`; the agents package does it when the app gives a step-up handler).
 */
export const BYPASS_SUPPORTS: readonly string[] = Object.freeze(["tool_mode.bypass", "bypass.step_up"]);

/** A request, built afresh for each attempt (a retry needs a new body). */
export interface RequestSpec {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
}

/**
 * Authenticated requests to a Fadenstack server, with the client's tokens and typed errors. Public, so modules
 * add resources without copying the plumbing.
 */
export class FadenstackTransport {
  readonly serverUrl: URL;
  readonly apiUrl: URL;
  readonly timeoutMs: number;
  readonly fetch: FetchLike;
  readonly #credentials: TokenProvider | undefined;
  readonly #supports = new Set<string>();
  #logger: FadenstackLogger | undefined;

  constructor(options: TransportOptions) {
    this.#logger = options.logger;
    this.serverUrl = withSlash(requireUrl(options.serverUrl, "serverUrl", options.allowInsecureHttp));
    this.apiUrl = withSlash(requireUrl(options.apiUrl ?? this.serverUrl, "apiUrl", options.allowInsecureHttp));
    this.#credentials = options.credentials;
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Names what this client can do (`X-Faden-Client-Supports`, on every request from now on): the server offers new
   * levels and fields only to clients that name them. Nothing is announced unless this is called.
   */
  announce(...features: readonly string[]): void {
    for (const feature of features) {
      if (!/^[a-z][a-z0-9_.]*$/.test(feature)) throw new TypeError(`'${feature}' is not a feature name.`);
      this.#supports.add(feature);
    }
  }

  /** Where the client logs, if the host gave a logger. */
  get logger(): FadenstackLogger | undefined {
    return this.#logger;
  }

  /** Takes `logger` as the client's logger unless it already has one (the agent builder's `useLogging` reaches a client made elsewhere). */
  useLogger(logger: FadenstackLogger): void {
    this.#logger ??= logger;
  }

  /** What this client announces, in the order given. */
  get announced(): readonly string[] {
    return [...this.#supports];
  }

  /** A gateway route: `gateway("v1/sessions")`. */
  gateway(relative: string): URL {
    return new URL(relative.replace(/^\/+/, ""), this.serverUrl);
  }

  /** A backend route: `api("api/agent-tokens")`. */
  api(relative: string): URL {
    return new URL(relative.replace(/^\/+/, ""), this.apiUrl);
  }

  /**
   * Sends a request with the bearer token and reads the whole answer. A 401 gets one retry with a fresh token, except
   * a step-up challenge.
   * Errors are not thrown here: the caller reads the status (a refusal can be an answer).
   */
  async request(build: () => RequestSpec, signal?: AbortSignal): Promise<{ response: Response; text: string }> {
    return this.#withTimeout(signal, async (linked) => {
      const response = await this.#send(build, linked);
      return { response, text: await response.text() };
    }, true);
  }

  /** Like `request`, but returns once the headers are in: the body is a stream the caller reads. */
  async open(build: () => RequestSpec, signal?: AbortSignal): Promise<Response> {
    return this.#withTimeout(signal, (linked) => this.#send(build, linked), false, signal);
  }

  /** JSON in, JSON out; errors as typed exceptions. */
  async json<T>(method: string, url: URL, body?: unknown, signal?: AbortSignal): Promise<T> {
    const { response, text } = await this.request(() => jsonRequest(method, url, body), signal);
    if (!response.ok) throw toApiError(response, text);
    return (text.trim() === "" ? undefined : JSON.parse(text)) as T;
  }

  get<T>(url: URL, signal?: AbortSignal): Promise<T> {
    return this.json<T>("GET", url, undefined, signal);
  }

  post<T>(url: URL, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.json<T>("POST", url, body, signal);
  }

  patch<T>(url: URL, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.json<T>("PATCH", url, body, signal);
  }

  delete(url: URL, signal?: AbortSignal): Promise<void> {
    return this.json<void>("DELETE", url, undefined, signal);
  }

  async #send(build: () => RequestSpec, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const spec = build();
      const headers = new Headers(spec.headers);
      if (this.#supports.size > 0 && !headers.has(CLIENT_SUPPORTS_HEADER)) headers.set(CLIENT_SUPPORTS_HEADER, [...this.#supports].join(", "));
      let token: string | undefined;
      if (this.#credentials && !headers.has("authorization")) {
        token = await this.#credentials.getAccessToken(signal);
        headers.set("authorization", `Bearer ${token}`);
      }
      let response: Response;
      const started = performance.now();
      try {
        // Never the browser's cookies: a console session for the same server would act instead of the app's user.
        const init: RequestInit = { method: spec.method, headers, signal, credentials: "omit" };
        if (spec.body !== undefined) init.body = spec.body;
        response = await this.fetch(spec.url, init);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        writeLog(this.#logger, ClientLog.requestFailed, { Method: spec.method, Route: spec.url.pathname,
          ErrorType: error instanceof Error ? error.name : typeof error, DurationMs: Math.round(performance.now() - started), Attempt: attempt + 1 });
        throw new FadenstackUnreachableError(`Fadenstack could not be reached: ${describe(error)}`, { cause: error });
      }
      writeLog(this.#logger, ClientLog.request, { Method: spec.method, Route: spec.url.pathname, Status: response.status,
        DurationMs: Math.round(performance.now() - started), Attempt: attempt + 1 });
      // A step-up challenge (RFC 9470: a fresh sign-in is needed, `bypass_step_up_required`) is not a bad token: no
      // refresh and no second request -- it goes to the caller, who starts the second sign-in.
      if (response.status === 401 && token !== undefined && attempt === 0 && !isStepUpChallenge(response)) {
        await response.body?.cancel().catch(() => undefined);
        await this.#credentials!.invalidate(token);
        continue;
      }
      return response;
    }
  }

  /**
   * Runs `work` under the caller's signal and the transport's timeout. For a stream the timeout covers only
   * the wait for the headers; the caller's signal stays linked for the body.
   */
  async #withTimeout<T>(
    signal: AbortSignal | undefined,
    work: (linked: AbortSignal) => Promise<T>,
    wholeBody: boolean,
    bodySignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) throw signal.reason ?? abortError();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new FadenstackError(`Fadenstack did not answer within ${Math.round(this.timeoutMs / 1000)} s.`));
    }, this.timeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (timedOut) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      // A stream's body keeps listening to the caller (bodySignal); a whole request is done with it.
      if (wholeBody || !bodySignal) signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function jsonRequest(method: string, url: URL, body?: unknown): RequestSpec {
  const spec: RequestSpec = { method, url, headers: { accept: "application/json" } };
  if (body !== undefined) {
    spec.headers!["content-type"] = "application/json";
    spec.body = JSON.stringify(body);
  }
  return spec;
}

/** A 401 that asks for a fresher sign-in (RFC 9470 `insufficient_user_authentication`), not for a new token. */
export function isStepUpChallenge(response: Response): boolean {
  return /\berror\s*=\s*"?insufficient_user_authentication\b/i.test(response.headers.get("www-authenticate") ?? "");
}

function requireUrl(value: string | URL, name: string, allowInsecureHttp: boolean | undefined): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} is not a URL: ${String(value)}`);
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new TypeError(`Fadenstack is reached over https. Set allowInsecureHttp only for a development server (${name}).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${name} must be an http(s) URL.`);
  }
  return url;
}

/** Whether `url` is this machine: localhost, 127.0.0.0/8 or ::1. */
export function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * `value` as an address credentials may go to: https, http to this machine, or any http with
 * `allowInsecureHttp` (a development server). Sign-ins, logins and agent setup check it before they send anything.
 */
export function requireSecureUrl(value: string | URL, name: string, allowInsecureHttp?: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} is not a URL: ${String(value)}`);
  }
  return requireUrl(url, name, allowInsecureHttp || isLoopback(url));
}

function withSlash(url: URL): URL {
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
