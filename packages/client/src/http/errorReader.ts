import {
  FadenApiError,
  FadenAuthenticationError,
  FadenFeatureNotAvailableError,
  FadenPermissionError,
  FadenRateLimitedError,
} from "../errors.js";

/** An error body's fields: the gateway's OpenAI shape (`error`) or the backend's `detail`. */
export interface ParsedError {
  message: string;
  code?: string;
  type?: string;
  param?: string;
  /** The gateway's `faden` block, e.g. a refusal's `governance`. */
  faden?: Record<string, unknown>;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function parseError(body: string, fallback: string): ParsedError {
  let root: unknown;
  try {
    root = JSON.parse(body.trim() === "" ? "{}" : body);
  } catch {
    return { message: body.trim() === "" ? fallback : truncate(body) };
  }
  const top = obj(root);
  const faden = obj(top?.["faden"]);
  const error = obj(top?.["error"]);
  if (error) {
    return withFaden({
      message: str(error["message"]) ?? fallback,
      code: str(error["code"]),
      type: str(error["type"]),
      param: str(error["param"]),
    }, faden);
  }
  const detail = top?.["detail"];
  if (obj(detail)) {
    return withFaden({ message: str(obj(detail)!["message"]) ?? fallback, code: str(obj(detail)!["code"]) }, faden);
  }
  if (typeof detail === "string") {
    return withFaden({ message: detail }, faden);
  }
  if (Array.isArray(detail)) {
    // FastAPI's validation errors: [{ loc, msg, type }, ...]
    const messages = detail.map((d) => str(obj(d)?.["msg"])).filter((m): m is string => !!m);
    return withFaden({ message: messages.length ? messages.join("; ") : fallback, code: "validation_error" }, faden);
  }
  return { message: fallback };
}

function withFaden(parsed: ParsedError, faden: Record<string, unknown> | undefined): ParsedError {
  const out: ParsedError = { message: parsed.message };
  if (parsed.code !== undefined) out.code = parsed.code;
  if (parsed.type !== undefined) out.type = parsed.type;
  if (parsed.param !== undefined) out.param = parsed.param;
  if (faden !== undefined) out.faden = faden;
  return out;
}

/** The typed error for a failed response, from its status and body. */
export function toApiError(response: Response, body: string): FadenApiError {
  const status = response.status;
  const parsed = parseError(body, `${status} ${response.statusText}`.trim());
  const fields = { code: parsed.code, type: parsed.type, param: parsed.param };
  switch (status) {
    case 401:
      return new FadenAuthenticationError(status, parsed.message, { ...fields, type: "authentication_error" });
    case 403:
      return new FadenPermissionError(status, parsed.message, fields);
    case 404:
      return parsed.code === "ee_required"
        ? new FadenFeatureNotAvailableError(parsed.message)
        : new FadenApiError(status, parsed.message, fields);
    case 429:
      return new FadenRateLimitedError(status, parsed.message, parsed.code, retryAfterMs(response.headers));
    default:
      return new FadenApiError(status, parsed.message, fields);
  }
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function truncate(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}
