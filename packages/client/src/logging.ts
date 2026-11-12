/**
 * What the SDK logs: names, ids, counts, durations and outcomes -- never a prompt, an answer, reasoning, attachment text,
 * tool arguments or results, a token, a secret, or who the user is. The same events, ids, names and fields as the .NET
 * SDK's (`Fadenstack.Client.Log` 1000-1033, `Fadenstack.Agents.Log` 2000-2030), so one dashboard reads both. The host
 * plugs in a `FadenstackLogger` (`AgentBuilder.useLogging`, the client's `logger` option); there is no file sink in a
 * browser. A logger that throws never fails the SDK.
 */

/** .NET's `LogLevel` names the SDK uses. */
export type LogLevel = "debug" | "information" | "warning" | "error";

/** A field's value: a name, an id, a count, a duration, a yes or no. Never a structure, so never content. */
export type LogValue = string | number | boolean | null;

/** The turn an entry belongs to (.NET's log scope `conversation {ConversationId} turn {TurnId}`). */
export interface LogScope {
  readonly ConversationId: string;
  readonly TurnId: string;
}

/** One log entry. */
export interface LogEvent {
  /** `Fadenstack.Client` or `Fadenstack.Agents`. */
  readonly category: string;
  /** The event id (1000-1033 the client, 2000-2030 the agent). */
  readonly eventId: number;
  /** The event's name, as the .NET SDK names it: `Request`, `ProfileLoaded`, `TurnEnded`... */
  readonly eventName: string;
  readonly level: LogLevel;
  /** The message with its fields put in. */
  readonly message: string;
  /** The fields, under the names the .NET message uses for them (`Agent`, `DurationMs`...). */
  readonly fields: Readonly<Record<string, LogValue>>;
  readonly scope?: LogScope;
}

/** Where the SDK's log entries go. The host forwards them to its own logger, a console, a service. */
export interface FadenstackLogger {
  log(event: LogEvent): void;
}

/** A logger that drops everything: the default. */
export const noLogger: FadenstackLogger = Object.freeze({ log: () => undefined });

const ORDER: Record<LogLevel, number> = { debug: 0, information: 1, warning: 2, error: 3 };

/** A logger that writes to a console (`globalThis.console` by default), entries below `minimum` dropped. For development; the entries hold no content. */
export function consoleLogger(minimum: LogLevel = "information",
  sink: Pick<Console, "debug" | "info" | "warn" | "error"> = globalThis.console): FadenstackLogger {
  return {
    log(event) {
      if (ORDER[event.level] < ORDER[minimum]) return;
      const write = event.level === "debug" ? sink.debug : event.level === "information" ? sink.info : event.level === "warning" ? sink.warn : sink.error;
      write.call(sink, `[${event.category}] ${event.eventId} ${event.message}`);
    },
  };
}

/** The longest text a field carries: a name or an id, never a body. */
const MAX_FIELD_TEXT = 200;

/** What one entry says before its fields are put in. */
export interface LogDefinition {
  readonly category: string;
  readonly eventId: number;
  readonly eventName: string;
  readonly level: LogLevel;
  /** The message with `{Field}` placeholders, as .NET's `LoggerMessage` has it. */
  readonly template: string;
}

export function defineLog(category: string, eventId: number, eventName: string, level: LogLevel, template: string): LogDefinition {
  return Object.freeze({ category, eventId, eventName, level, template });
}

/**
 * Writes one entry. Fields are primitives only (a structure is dropped to its type name) and text is cut at 200
 * characters, so a mistake at a call site cannot send a document; a logger that throws is ignored.
 */
export function writeLog(logger: FadenstackLogger | undefined, definition: LogDefinition, fields: Record<string, unknown>, scope?: LogScope): void {
  if (!logger || logger === noLogger) return;
  try {
    const clean: Record<string, LogValue> = {};
    for (const [name, value] of Object.entries(fields)) clean[name] = value === undefined ? null : primitive(value);
    const message = definition.template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = clean[name];
      return value === null || value === undefined ? "(null)" : String(value);
    });
    logger.log({ category: definition.category, eventId: definition.eventId, eventName: definition.eventName, level: definition.level, message,
      fields: Object.freeze(clean), ...(scope ? { scope } : {}) });
  } catch {
    // a broken logger never fails a turn or a request
  }
}

function primitive(value: unknown): LogValue {
  if (value === null) return null;
  if (typeof value === "string") return value.length > MAX_FIELD_TEXT ? `${value.slice(0, MAX_FIELD_TEXT - 1)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return typeof value; // a structure, a function: only that it was one
}

/** The category of everything the client logs. */
export const CLIENT_LOG_CATEGORY = "Fadenstack.Client";

/** The client's entries: the .NET `Fadenstack.Client.Log`. */
export const ClientLog = Object.freeze({
  request: defineLog(CLIENT_LOG_CATEGORY, 1000, "Request", "information", "{Method} {Route} answered {Status} in {DurationMs} ms (attempt {Attempt})"),
  requestFailed: defineLog(CLIENT_LOG_CATEGORY, 1001, "RequestFailed", "warning", "{Method} {Route} failed with {ErrorType} after {DurationMs} ms (attempt {Attempt})"),
  tokenRefreshed: defineLog(CLIENT_LOG_CATEGORY, 1010, "TokenRefreshed", "information", "The sign-in to agent {Agent} was renewed"),
  tokenRefreshFailed: defineLog(CLIENT_LOG_CATEGORY, 1011, "TokenRefreshFailed", "warning", "The sign-in to agent {Agent} could not be renewed ({Reason})"),
  signedOut: defineLog(CLIENT_LOG_CATEGORY, 1012, "SignedOut", "information", "Signed out of agent {Agent} on this device (revoked at the server: {Revoked})"),
  signOutRevokeFailed: defineLog(CLIENT_LOG_CATEGORY, 1013, "SignOutRevokeFailed", "warning",
    "The sign-in to agent {Agent} could not be revoked at the server ({Reason}); it is deleted here"),
  eventSkipped: defineLog(CLIENT_LOG_CATEGORY, 1020, "EventSkipped", "warning", "A faden event was skipped: it is {Reason}"),
  pairingStarted: defineLog(CLIENT_LOG_CATEGORY, 1030, "PairingStarted", "information", "Pairing for agent {Agent} started; it is valid for {ExpiresInS} s"),
  pairingSlowedDown: defineLog(CLIENT_LOG_CATEGORY, 1031, "PairingSlowedDown", "information", "Pairing for agent {Agent}: the server asked to slow down ({IntervalS} s)"),
  pairingRetrying: defineLog(CLIENT_LOG_CATEGORY, 1032, "PairingRetrying", "warning",
    "Pairing for agent {Agent}: the server could not be reached ({Reason}); trying again in {WaitS} s"),
  pairingEnded: defineLog(CLIENT_LOG_CATEGORY, 1033, "PairingEnded", "information", "Pairing for agent {Agent} ended: {Outcome}"),
});
