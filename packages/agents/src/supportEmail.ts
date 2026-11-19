/**
 * The address a "Report a problem" mail goes to (sdk/0.3.1). It must be one plain address, so that a machine policy or a host option
 * cannot add a recipient, a bcc or a body to the draft (OWASP ASVS 5.0 V1). The same rule in the .NET SDK (`SupportEmail`).
 */

/** The address of Fadenstack's own support: the standalone default (never used in governed mode). */
export const DEFAULT_SUPPORT_EMAIL = "support@fadenstack.com";

/** The longest address, in characters (RFC 5321). */
export const SUPPORT_EMAIL_MAX_LENGTH = 254;

// `$` in JavaScript matches only at the very end of the text, never before a final line break (unlike .NET's `$`, which needs `\z`).
const PATTERN = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * Whether `value` is one plain mail address: `^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, at most 254 characters. A `?`, `&`,
 * `%`, `,`, a space, a line break or a second address makes it false. No trimming: a value with a space around it is refused.
 */
export function isSupportEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= SUPPORT_EMAIL_MAX_LENGTH && PATTERN.test(value);
}
