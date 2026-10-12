/** Something went wrong reaching Fadenstack, or the server refused the request. */
export class FadenstackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * No answer at all: the address is wrong, the server is down, or the certificate is not trusted (a browser does not
 * say which). `cause` is the platform's error.
 */
export class FadenstackUnreachableError extends FadenstackError {}

/** The server answered with an error: its status, and the OpenAI-shaped error's fields. */
export class FadenstackApiError extends FadenstackError {
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
export class FadenstackAuthenticationError extends FadenstackApiError {}

/** 403: the user may not do this (no grant, the agent is retired, ...). */
export class FadenstackPermissionError extends FadenstackApiError {}

/** 429: a limit applied. `code` says which; `retryAfterMs` says when to try again, if the server said. */
export class FadenstackRateLimitedError extends FadenstackApiError {
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, code: string | undefined, retryAfterMs: number | undefined) {
    super(status, message, { code, type: "rate_limit_error" });
    this.retryAfterMs = retryAfterMs;
  }
}

/** An answer that had started broke off; the server said so before it ended. */
export class FadenstackStreamError extends FadenstackError {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** The agent's sign-in is gone (never made, expired, or revoked): sign in again. */
export class FadenstackSignInRequiredError extends FadenstackError {}

/** Whether `error` is the caller's own cancellation (an aborted signal), not a failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
