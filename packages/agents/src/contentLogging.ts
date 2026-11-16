import { FadenstackError, writeLog, type FadenstackLogger } from "@fadenstack/client";

import { AgentLog } from "./log.js";

/** Why an app could not switch content logging on (`ContentLoggingError.reason`). .NET: `ContentLoggingRefusal`. */
export type ContentLoggingRefusal =
  /** The app did not offer content logging (`useHookContent` was not set). */
  | "notOffered"
  /** The machine policy on this computer forbids it (`contentLogging: "forbidden"`). */
  | "forbiddenByPolicy";

/**
 * The agent would not switch content logging on: the app did not offer it, or the machine policy forbids it. Nothing was switched on.
 * .NET: `ContentLoggingException`.
 */
export class ContentLoggingError extends FadenstackError {
  /** Why it was refused. */
  readonly reason: ContentLoggingRefusal;

  constructor(reason: ContentLoggingRefusal) {
    super(reason === "forbiddenByPolicy" ? "The policy of this computer does not allow content logging." : "This app does not offer content logging.");
    this.reason = reason;
  }
}

/** The shortest time content logging can be switched on for: 15 minutes (in milliseconds). .NET: `ContentLoggingState.MinDuration`. */
export const CONTENT_LOGGING_MIN_MS = 15 * 60 * 1000;
/** The longest time content logging can be switched on for: 24 hours (in milliseconds). .NET: `ContentLoggingState.MaxDuration`. */
export const CONTENT_LOGGING_MAX_MS = 24 * 60 * 60 * 1000;
/** What the UI offers first: one hour. .NET: `ContentLoggingState.DefaultDuration`. */
export const CONTENT_LOGGING_DEFAULT_MS = 60 * 60 * 1000;

/** @internal Starts a timer that calls `run` after `ms` and returns what stops it (tests move it by hand). */
export type ContentLoggingSchedule = (ms: number, run: () => void) => () => void;

/** @internal What the agent hands the switch. */
export interface ContentLoggingInit {
  readonly agent: string;
  readonly offered: boolean;
  readonly allowedByPolicy: boolean;
  readonly logger: FadenstackLogger | undefined;
  readonly now?: () => number;
  readonly schedule?: ContentLoggingSchedule;
}

/**
 * Whether the agent writes content (prompts, answers, tool arguments and results) where an app's hooks can see it, right now
 * (`FadenstackAgent.contentLogging`). Content is personal data, so it is OFF by default and only the person switches it on, for a set
 * time (15 minutes to 24 hours). It ends by itself at `until`, it is not kept across restarts, and a band in the chat says while it is on
 * (OWASP ASVS 5.0 V16, security logging: no sensitive data in logs unless it is a visible, time-limited choice). What the app sets at build time
 * (`useHookContent`) only means "this app offers content logging" (`offered`). A development setup calls
 * `FadenstackAgent.startContentLogging` itself. The TypeScript SDK has no OpenTelemetry chat client (.NET has), so here it is the
 * model-call hooks' message and answer text that follow it. .NET: `ContentLoggingState` (`agent.ContentLogging`).
 */
export class ContentLogging {
  readonly #agent: string;
  readonly #logger: FadenstackLogger | undefined;
  readonly #now: () => number;
  readonly #schedule: ContentLoggingSchedule;
  readonly #listeners = new Set<() => void>();
  #until: number | undefined;
  #stopTimer: (() => void) | undefined;
  #disposed = false;

  /** @internal */
  constructor(init: ContentLoggingInit) {
    this.#agent = init.agent;
    this.offered = init.offered;
    this.allowedByPolicy = init.allowedByPolicy;
    this.#logger = init.logger;
    this.#now = init.now ?? (() => Date.now());
    this.#schedule = init.schedule ?? ((ms, run) => {
      const handle = setTimeout(run, ms);
      (handle as { unref?: () => void }).unref?.(); // a timer must not keep a process alive
      return () => clearTimeout(handle);
    });
  }

  /** The app offers content logging (it asked for hook content at build time). */
  readonly offered: boolean;
  /** The machine policy on this computer does not forbid it (`contentLogging`). */
  readonly allowedByPolicy: boolean;

  /** The person can switch it on: `offered` and `allowedByPolicy`. A control shows only then. */
  get canStart(): boolean {
    return this.offered && this.allowedByPolicy;
  }

  /** Content flows to the hooks now. Every call compares the clock with `until`, so a machine that slept cannot overrun it. */
  get isOn(): boolean {
    const was = this.#until;
    if (this.#expireIfDue() && was !== undefined) this.#ended(was, "expired");
    return this.#until !== undefined;
  }

  /** When it ends, as a time in milliseconds since 1970 (UTC); undefined while off. */
  get until(): number | undefined {
    return this.isOn ? this.#until : undefined;
  }

  /** Calls `listener` when content logging goes on or off (also when it ends by itself). Returns what stops listening. */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @internal Use `FadenstackAgent.startContentLogging`. */
  start(durationMs: number): void {
    if (!this.offered) throw new ContentLoggingError("notOffered");
    if (!this.allowedByPolicy) throw new ContentLoggingError("forbiddenByPolicy");
    if (!Number.isFinite(durationMs) || durationMs < CONTENT_LOGGING_MIN_MS || durationMs > CONTENT_LOGGING_MAX_MS) {
      throw new RangeError("Content logging can be switched on for 15 minutes to 24 hours.");
    }
    if (this.#disposed) throw new Error("The agent was disposed.");
    const until = this.#now() + durationMs;
    this.#until = until;
    this.#arm(durationMs);
    writeLog(this.#logger, AgentLog.contentLoggingStarted, { Agent: this.#agent, Minutes: Math.round(durationMs / 60000), Until: new Date(until).toISOString() });
    this.#changed();
  }

  /** @internal Use `FadenstackAgent.stopContentLogging`. */
  stop(): void {
    const was = this.#until;
    this.#until = undefined;
    this.#stopTimer?.();
    this.#stopTimer = undefined;
    if (was !== undefined) this.#ended(was, "stopped");
  }

  /** @internal Stops the timer; content logging is off from here on. */
  dispose(): void {
    this.#disposed = true;
    this.#until = undefined;
    this.#stopTimer?.();
    this.#stopTimer = undefined;
  }

  /** Switches off when the time is up. True when it did. */
  #expireIfDue(): boolean {
    if (this.#until !== undefined && this.#now() >= this.#until) {
      this.#until = undefined;
      this.#stopTimer?.();
      this.#stopTimer = undefined;
      return true;
    }
    return false;
  }

  #arm(ms: number): void {
    this.#stopTimer?.();
    this.#stopTimer = this.#schedule(ms, () => this.#tick());
  }

  #tick(): void {
    const was = this.#until;
    if (this.#expireIfDue()) {
      if (was !== undefined) this.#ended(was, "expired");
    } else if (this.#until !== undefined && !this.#disposed) {
      this.#arm(Math.max(this.#until - this.#now(), 1)); // fired early: once more
    }
  }

  #ended(until: number, how: string): void {
    writeLog(this.#logger, AgentLog.contentLoggingStopped, { Agent: this.#agent, How: how, Until: new Date(until).toISOString() });
    this.#changed();
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // a listener's failure is not the switch's
      }
    }
  }
}
