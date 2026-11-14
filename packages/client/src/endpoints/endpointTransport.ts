import type { TokenProvider } from "../auth/tokens.js";
import { FadenstackApiError, FadenstackError, FadenstackRateLimitedError } from "../errors.js";
import { parseError, retryAfterMs } from "../http/errorReader.js";
import type { FetchLike } from "../http/transport.js";
import { ClientLog, writeLog, type FadenstackLogger } from "../logging.js";
import type { ModelEndpoint } from "./endpoint.js";
import { EndpointDialect } from "./endpoint.js";
import {
  EndpointContextLengthError,
  EndpointKeyRejectedError,
  EndpointModelNotFoundError,
  EndpointNotCompatibleError,
  EndpointOriginRefusedError,
  EndpointPlainHttpRefusedError,
  EndpointUnreachableError,
  ServerCertificateError,
} from "./endpointErrors.js";
import { endpointBase, endpointOrigin } from "./endpointUrl.js";
import { hostScope } from "./hostScope.js";

/** A request, built afresh for each attempt (a redirect or a retry needs a new body). */
export interface EndpointRequest {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The longest answer body read whole (not streamed), in characters. */
export const ENDPOINT_MAX_BODY_CHARS = 32 * 1024 * 1024;

const MAX_REDIRECTS = 3;

/** TLS error codes (Node) that mean the server's certificate is not trusted. */
const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED", "CERT_REVOKED", "CERT_SIGNATURE_FAILURE", "HOSTNAME_MISMATCH", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Requests to a person's own endpoint, under the transport rules (sdk/51 F03, D3; OWASP ASVS 5.0 V12 secure communication,
 * V13 configuration and secrets):
 *
 * - https, or plain http to this device; plain http to a private network only with the endpoint's opt-in; a key never over
 *   plain http, so a request that would carry one is refused before anything is sent (`checkPlainHttp`);
 * - `redirect: "manual"`, as the gateway's transport: a browser answers an opaque redirect (the typed `redirect` error,
 *   nothing sent again); where the `Location` is visible (Node) a redirect to the same origin is followed (at most three,
 *   body and key sent again), any other is refused, so the key and the body never leave the origin they were meant for;
 * - errors as typed errors (`toEndpointError`): a refused key, a refused origin, no such model, the context length, not
 *   compatible, unreachable, the certificate, the rate limit (a `FadenstackRateLimitedError`).
 *
 * .NET: `EndpointTransport`.
 */
export class EndpointTransport {
  readonly endpoint: ModelEndpoint;
  /** The base, with one trailing slash. */
  readonly base: URL;
  readonly timeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #logger: FadenstackLogger | undefined;

  constructor(endpoint: ModelEndpoint) {
    this.endpoint = endpoint;
    this.base = endpointBase(endpoint.baseUrl);
    this.timeoutMs = endpoint.timeoutMs ?? 5 * 60_000;
    this.streamIdleTimeoutMs = endpoint.streamIdleTimeoutMs ?? 5 * 60_000;
    if (!(this.streamIdleTimeoutMs > 0)) throw new TypeError("streamIdleTimeoutMs must be positive, or Infinity.");
    this.#fetch = endpoint.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#logger = endpoint.logger;
  }

  get dialect(): EndpointDialect {
    return this.endpoint.dialect ?? EndpointDialect.openAiCompatible;
  }

  /** Sends a request and reads the whole answer (capped); the time limit covers the body too. */
  async request(url: URL, build: (url: URL) => EndpointRequest, signal?: AbortSignal): Promise<{ response: Response; text: string }> {
    return this.#withTimeout(signal, async (linked) => {
      const response = await this.#send(url, build, linked);
      return { response, text: await textOf(response) };
    }, true);
  }

  /** Like `request`, but returns once the headers are in: the body is a stream the caller reads. */
  async open(url: URL, build: (url: URL) => EndpointRequest, signal?: AbortSignal): Promise<Response> {
    return this.#withTimeout(signal, (linked) => this.#send(url, build, linked), false);
  }

  /**
   * Sends the request `build` makes for a URL: first for `url`, then for each same-origin redirect. A 401 is tried once more
   * when the key provider gives a different key.
   */
  async #send(url: URL, build: (url: URL) => EndpointRequest, signal: AbortSignal): Promise<Response> {
    const origin = endpointOrigin(this.base);
    const provider: TokenProvider | undefined = this.endpoint.key;
    let rejected: string | undefined;
    for (let attempt = 0, redirects = 0; ; attempt++) {
      if (endpointOrigin(url) !== origin) throw new TypeError("A request to an endpoint stays at the endpoint's own origin.");
      checkPlainHttp(url, this.endpoint);
      const spec = build(url);
      const key = provider ? await provider.getAccessToken(signal) : undefined;
      const headers = new Headers(spec.headers);
      if (key !== undefined) {
        if (this.dialect.keyHeader === "ApiKey") headers.set("api-key", key);
        else headers.set("authorization", `Bearer ${key}`);
      }
      const route = url.pathname;
      const started = performance.now();
      let response: Response;
      try {
        // Never the browser's cookies, and no redirect followed on the runtime's own.
        const init: RequestInit = { method: spec.method, headers, signal, credentials: "omit", redirect: "manual" };
        if (spec.body !== undefined) init.body = spec.body;
        response = await this.#fetch(url, init);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        writeLog(this.#logger, ClientLog.requestFailed, { Method: spec.method, Route: route,
          ErrorType: error instanceof Error ? error.name : typeof error, DurationMs: Math.round(performance.now() - started), Attempt: attempt + 1 });
        throw unreachable(error);
      }
      writeLog(this.#logger, ClientLog.request, { Method: spec.method, Route: route, Status: response.status,
        DurationMs: Math.round(performance.now() - started), Attempt: attempt + 1 });
      if (response.status === 401 && key !== undefined && rejected === undefined && provider) {
        // An Entra token may have expired; an API key gives itself again, and then one try is the end of it.
        await response.body?.cancel().catch(() => undefined);
        rejected = key;
        await provider.invalidate(key);
        if ((await provider.getAccessToken(signal)) !== key) continue;
        throw new EndpointKeyRejectedError(401, "The endpoint refused the key (401).");
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status <= 399)) {
        // A browser hides where it pointed (opaque redirect, status 0): that is refused as it is. Node shows the Location.
        const status = response.status;
        const location = response.type === "opaqueredirect" ? undefined : response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        const to = location ? tryUrl(location, url) : undefined;
        if (to === undefined || endpointOrigin(to) !== origin || ++redirects > MAX_REDIRECTS) throw redirected(status, to);
        url = to;
        continue;
      }
      return response;
    }
  }

  /**
   * Runs `work` under the caller's signal and the endpoint's timeout. For a stream the timeout covers only the wait for the
   * headers; the caller's signal stays linked for the body.
   */
  async #withTimeout<T>(signal: AbortSignal | undefined, work: (linked: AbortSignal) => Promise<T>, wholeBody: boolean): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) throw signal.reason ?? abortError();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new EndpointUnreachableError(`The endpoint did not answer within ${Math.round(this.timeoutMs / 1000)} s.`));
    }, this.timeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (timedOut) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      if (wholeBody) signal?.removeEventListener("abort", onAbort); // a stream's body keeps listening to the caller
    }
  }
}

function tryUrl(location: string, base: URL): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/** A redirect that is not followed: another origin, too many, one the browser hid, or none named. */
function redirected(status: number, to: URL | undefined): FadenstackApiError {
  return new FadenstackApiError(status,
    `The endpoint redirected the request to ${to === undefined ? "another address" : `${to.protocol}//${to.host}${to.pathname}`}. `
    + "Requests to an endpoint never leave its own origin: check the endpoint's address (https, the right path).",
    { code: "redirect" });
}

/**
 * D3: plain http only to this device, or to a private network after the endpoint's opt-in; never with a key. Decided by the
 * host's spelling (`hostScope`: a browser cannot resolve names). Throws `EndpointPlainHttpRefusedError`, before anything is sent.
 */
export function checkPlainHttp(url: URL, endpoint: Pick<ModelEndpoint, "key" | "allowPlainHttpInLan">): void {
  if (url.protocol !== "http:") return;
  if (endpoint.key) {
    throw new EndpointPlainHttpRefusedError("keyOverPlainHttp", "A key never travels over plain http: use the endpoint's https address, or leave the key out.");
  }
  const scope = hostScope(url.hostname);
  if (scope === "loopback") return;
  if (scope === "private") {
    if (endpoint.allowPlainHttpInLan) return;
    throw new EndpointPlainHttpRefusedError("noOptIn",
      "Plain http to another computer in the local network needs the person's opt-in for this endpoint; https is better.");
  }
  throw new EndpointPlainHttpRefusedError("notLocal",
    "Plain http goes only to this computer or, with an opt-in, to the local network: use the endpoint's https address.");
}

/** A request that got no answer: unreachable, or (where the platform says so) a certificate that is not trusted. */
function unreachable(error: unknown): FadenstackError {
  for (let inner: unknown = error, depth = 0; inner && depth < 8; depth++) {
    const code = typeof inner === "object" && "code" in inner ? String((inner as { code: unknown }).code) : "";
    if (CERTIFICATE_CODES.has(code)) {
      return new ServerCertificateError("The endpoint's certificate is not trusted (an unknown CA, a name that does not match, or expired).", { cause: error });
    }
    inner = typeof inner === "object" ? (inner as { cause?: unknown }).cause : undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EndpointUnreachableError(`The endpoint could not be reached: ${message}`, { cause: error });
}

/** An answer's body as text, at most `ENDPOINT_MAX_BODY_CHARS` long. */
export async function textOf(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      text += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (text.length > ENDPOINT_MAX_BODY_CHARS) throw new FadenstackError("The endpoint's answer was larger than the SDK accepts.");
      if (done) return text;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The typed error for an error answer (review R2: the 429 stays a `FadenstackRateLimitedError`). */
export function toEndpointError(response: Response, body: string, keySent: boolean): FadenstackError {
  const status = response.status;
  const { message, code } = parseEndpointError(body, `${status} ${response.statusText}`.trim());
  const said = `${message} ${code ?? ""}`.toLowerCase();
  const detail = message.trim() === "" ? "" : `: ${message}`;
  switch (status) {
    case 401:
      return new EndpointKeyRejectedError(status, (keySent ? "The endpoint refused the key (401)" : "The endpoint needs a key (401)") + detail, code);
    case 403:
      return !keySent || said.includes("origin") || said.includes("cors")
        ? new EndpointOriginRefusedError(status, `The endpoint refused this origin (403)${detail}`, code)
        : new EndpointKeyRejectedError(status, `The endpoint refused the key (403)${detail}`, code);
    case 429:
      return new FadenstackRateLimitedError(status, `The endpoint's rate limit applied (429)${detail}`, code, retryAfterMs(response.headers));
  }
  if (isContextLength(said)) return new EndpointContextLengthError(status, `The request is longer than the model's context${detail}`, code);
  if (isModelNotFound(said, code)) return new EndpointModelNotFoundError(status, `The endpoint does not have that model${detail}`, code);
  if (status === 404 || status === 405) {
    return new EndpointNotCompatibleError(status,
      `No OpenAI-compatible chat API at this address (${status}): check the base, which includes /v1${detail}`, code);
  }
  return new FadenstackApiError(status, `The endpoint answered ${status}${detail}`, code === undefined ? {} : { code });
}

const isContextLength = (said: string): boolean =>
  ["context_length_exceeded", "context length", "context size", "maximum context", "context window", "exceed_context_size"].some((s) => said.includes(s));

const isModelNotFound = (said: string, code: string | undefined): boolean =>
  code === "model_not_found" || (said.includes("model") && ["not found", "does not exist", "not exist", "unknown model", "no such model"].some((s) => said.includes(s)));

/** The message and code of an error body: OpenAI's `{"error": {...}}`, Ollama's `{"error": "..."}`, vLLM's `{"object": "error"}`, a `detail`. */
export function parseEndpointError(body: string, fallback: string): { message: string; code?: string } {
  const result = (message: string, code: string | undefined): { message: string; code?: string } =>
    code === undefined ? { message: truncate(message) } : { message: truncate(message), code };
  let root: unknown;
  try {
    root = JSON.parse(body.trim() === "" ? "{}" : body);
  } catch {
    root = undefined; // not JSON: the status says it
  }
  if (root !== null && typeof root === "object" && !Array.isArray(root)) {
    const top = root as Record<string, unknown>;
    const error = top["error"];
    if (typeof error === "string") return result(error, undefined);
    if (error !== null && typeof error === "object" && !Array.isArray(error)) {
      const e = error as Record<string, unknown>;
      const c = e["code"];
      const code = typeof c === "string" ? c : typeof c === "number" ? String(c) : undefined;
      const type = typeof e["type"] === "string" ? e["type"] : undefined;
      return result(typeof e["message"] === "string" ? e["message"] : fallback, code ?? type);
    }
    if (top["object"] === "error") {
      return result(typeof top["message"] === "string" ? top["message"] : fallback, typeof top["type"] === "string" ? top["type"] : undefined);
    }
  }
  const parsed = parseError(body, fallback);
  return result(parsed.message, parsed.code);
}

const truncate = (s: string): string => (s.length <= 300 ? s : `${s.slice(0, 300)}...`);

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
