/** Something went wrong reaching Fadenstack, or the server refused the request. */
export class FadenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * No answer at all: the address is wrong, the server is down, or the certificate is not trusted (a browser does not
 * say which). `cause` is the platform's error.
 */
export class FadenUnreachableError extends FadenError {}

/** The server answered with an error: its status, and the OpenAI-shaped error's fields. */
export class FadenApiError extends FadenError {
  readonly status: number;
  /** The error code, e.g. `agent_not_granted`, `tool_not_in_contract`. */
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly param: string | undefined;

  constructor(status: number, message: string, fields: { code?: string; type?: string; param?: string } = {}) {
    super(message);
    this.status = status;
    this.code = fields.code;
    this.type = fields.type;
    this.param = fields.param;
  }
}

/** 401: no or a bad token. For an agent: sign in again. */
export class FadenAuthenticationError extends FadenApiError {}

/** 403: the user may not do this (no grant, the agent is retired, ...). */
export class FadenPermissionError extends FadenApiError {}

/** 429: a rate limit or budget. `retryAfterMs` says when to try again, if the server said. */
export class FadenRateLimitedError extends FadenApiError {
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, code: string | undefined, retryAfterMs: number | undefined) {
    super(status, message, { code, type: "rate_limit_error" });
    this.retryAfterMs = retryAfterMs;
  }

  /** A budget (EE), not a rate limit. */
  get isBudget(): boolean {
    return this.code === "budget_exceeded";
  }
}

/** The route is an Enterprise feature this server does not have (404 `ee_required`). */
export class FadenFeatureNotAvailableError extends FadenApiError {
  constructor(message: string) {
    super(404, message, { code: "ee_required" });
  }
}

/** An answer that had started broke off; the server said so before it ended. */
export class FadenStreamError extends FadenError {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** The agent's sign-in is gone (never made, expired, or revoked): sign in again. */
export class FadenSignInRequiredError extends FadenError {}

/** Whether `error` is the caller's own cancellation (an aborted signal), not a failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
