import { FadenstackApiError, FadenstackUnreachableError } from "../errors.js";
import { redirectError, requireSecureUrl, type FetchLike } from "../http/transport.js";

/** How long the server may take (sdk/51 I15 §2). .NET: `ServerCheck.Timeout`. */
export const SERVER_CHECK_TIMEOUT_MS = 15_000;

export interface ServerCheckOptions {
  /** The server's address (where `/api` is); a path it sits under is kept. */
  server: string | URL;
  fetch?: FetchLike;
  /** Cancels the check; the cancellation is rethrown as it is. */
  signal?: AbortSignal;
  /** Allow plain http to another machine (a machine policy's http server, a development server). */
  allowInsecureHttp?: boolean;
}

/**
 * Whether an address answers like a Fadenstack server, before a pairing is started on it (sdk/51 I15 §2, the wizard's
 * "Checking"): `GET {server}/api/health`, 200 and a JSON object within 15 s. It shows only that something answers like the
 * platform: the anonymous health answer says nothing more on purpose, and "server too old" is found at the pairing's start.
 *
 * Typed failures: plain http to another machine (`FadenstackHttpsRequiredError`, nothing sent; OWASP ASVS 5.0 V12), no answer
 * (`FadenstackUnreachableError`; a browser does not say whether it was the certificate), and an answer that is not the
 * platform's, a redirect too (`FadenstackApiError` with code `not_fadenstack` or `redirect`). .NET: `ServerCheck.CheckAsync`.
 */
export async function checkServer(options: ServerCheckOptions): Promise<void> {
  const base = requireSecureUrl(options.server, "server", options.allowInsecureHttp);
  const url = new URL("api/health", base.href.endsWith("/") ? base : `${base.href}/`);
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const caller = options.signal;
  // A controller and a timer of our own, not AbortSignal.any with AbortSignal.timeout: Node holds those weakly, and a
  // collected one never fires.
  const limit = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; limit.abort(); }, SERVER_CHECK_TIMEOUT_MS);
  const stop = () => { limit.abort(caller?.reason); };
  caller?.addEventListener("abort", stop, { once: true });
  if (caller?.aborted) stop();
  try {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: "GET", credentials: "omit", redirect: "manual", signal: limit.signal, headers: { accept: "application/json" },
      });
      text = await response.text();
    } catch (error) {
      if (caller?.aborted) throw caller.reason ?? error;
      if (timedOut) {
        throw new FadenstackUnreachableError(`The server did not answer within ${SERVER_CHECK_TIMEOUT_MS / 1000} s.`, { cause: error });
      }
      throw new FadenstackUnreachableError(`The server could not be reached: ${(error as Error).message}`, { cause: error });
    }
    const redirected = redirectError(response, url);
    if (redirected) throw redirected;
    if (!response.ok || !isJsonObject(text)) {
      throw new FadenstackApiError(response.status, "This address does not answer like a Fadenstack server.", { code: "not_fadenstack" });
    }
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", stop);
  }
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}