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
  /** The error code, e.g. `agent_not_granted`, `bypass_step_up_required`; `redirect` when the server redirected a request. */
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

  /**
   * The server refused a picture because image generation is off in this version (core 0.7.1, EU AI Act Article 5): a 403 whose
   * code is `ErrorCodes.imagesDisabled`. Other 403s are not. .NET: `IsImagesDisabled`.
   */
  get isImagesDisabled(): boolean {
    return this.status === 403 && this.code === ErrorCodes.imagesDisabled;
  }

  /**
   * The organisation turned this agent off (core 0.7.1, the off-switch): a 403 whose code is `ErrorCodes.agentDisabled`. It is not
   * temporary and not worth a retry: the agent stays off until an administrator turns it on. Other 403s are not.
   * .NET: `IsAgentDisabled`.
   */
  get isAgentDisabled(): boolean {
    return this.status === 403 && this.code === ErrorCodes.agentDisabled;
  }
}

/** Error codes the server sends that an app may act on (`FadenstackApiError.code`). */
export const ErrorCodes = Object.freeze({
  /**
   * 403, error type `invalid_request_error`: image generation (`/v1/images/generations`, the agent's `images/generations`) is
   * turned off in this version, and `AgentProfile.images` is false. It is not temporary: do not retry.
   */
  imagesDisabled: "images_disabled",
  /**
   * 403, error type `permission_error`: the organisation turned this agent off (core 0.7.1). Every agent route but the profile, the
   * events and the manifest answers it until the agent is turned on again; do not retry (`FadenstackApiError.isAgentDisabled`).
   * .NET: `ErrorCodes.AgentDisabled`.
   */
  agentDisabled: "agent_disabled",
} as const);

/**
 * Whether `error` (or an error it was caused by) is the server's refusal of pictures: a 403 `images_disabled`. For an app that
 * asks the images route itself. .NET: `FadenstackApiException.IsImagesDisabled`.
 */
export function isImagesDisabled(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof FadenstackApiError && e.isImagesDisabled) return true;
  }
  return false;
}

/**
 * Whether `error` (or an error it was caused by) is the server's word that the organisation turned the agent off: a 403
 * `agent_disabled`. .NET: `FadenstackApiException.IsAgentDisabled`.
 */
export function isAgentDisabled(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof FadenstackApiError && e.isAgentDisabled) return true;
  }
  return false;
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

/**
 * The server named a sign-in page on another address than its own (a proxy passing on another `Host` or
 * `X-Forwarded-Proto`); it was not used (sdk/51 I15 §4). .NET: `FadenstackPairingPageElsewhereException`.
 */
export class FadenstackPairingPageElsewhereError extends FadenstackError {}

/**
 * Plain http where https is required (OWASP ASVS 5.0 V12 transport; sdk/51 I15 §4). A `TypeError` still, as the plain one
 * it replaces was, so a catch of that keeps working. .NET: `FadenstackHttpsRequiredException` (an `ArgumentException`).
 */
export class FadenstackHttpsRequiredError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "FadenstackHttpsRequiredError";
  }
}

/** The e-mail or password was refused (`LOGIN_BAD_CREDENTIALS`; sdk/51 I15 §4). .NET: `FadenstackBadCredentialsException`. */
export class FadenstackBadCredentialsError extends FadenstackApiError {
  constructor() {
    super(400, "The e-mail or password is not right.", { code: "LOGIN_BAD_CREDENTIALS" });
  }
}

/** The agent's sign-in is gone (never made, expired, or revoked): sign in again. */
export class FadenstackSignInRequiredError extends FadenstackError {}

/** Whether `error` is the caller's own cancellation (an aborted signal), not a failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
