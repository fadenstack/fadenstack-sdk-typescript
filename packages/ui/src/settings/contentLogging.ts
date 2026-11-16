import { CONTENT_LOGGING_DEFAULT_MS, ContentLoggingError, type FadenstackAgent } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings, type UiStrings } from "../strings.js";
import type { StringsSource } from "../skills/contracts.js";

/**
 * Where content logging's band and setting read and write its state: an agent (`contentLoggingSource(agent)`), or a test's.
 * .NET: `IContentLoggingSource`.
 */
export interface ContentLoggingSource {
  /** The app offers content logging and the machine policy allows it: only then is there anything to show. */
  readonly canStart: boolean;
  /** Content logging is on now. */
  readonly isOn: boolean;
  /** When it ends, in milliseconds since 1970 (UTC); undefined while off. */
  readonly until: number | undefined;
  /** Switches it on for a time (15 minutes to 24 hours). */
  start(durationMs: number): void;
  /** Switches it off. */
  stop(): void;
  /** Calls `listener` when it went on or off, also by itself at its end. Returns what stops listening. */
  onChanged(listener: () => void): () => void;
}

/** The content logging of `agent` as a source. .NET: `ContentLoggingSource.For`. */
export function contentLoggingSource(agent: FadenstackAgent): ContentLoggingSource {
  const state = agent.contentLogging;
  return {
    get canStart() { return state.canStart; },
    get isOn() { return state.isOn; },
    get until() { return state.until; },
    start: (durationMs) => agent.startContentLogging(durationMs),
    stop: () => agent.stopContentLogging(),
    onChanged: (listener) => state.onChanged(listener),
  };
}

/** The end time as the person reads it: the time of day in their locale, with the date when it is not today. */
export function contentLoggingTime(until: number, now: number, language: string): string {
  const end = new Date(until);
  const sameDay = end.toDateString() === new Date(now).toDateString();
  return sameDay
    ? end.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" })
    : end.toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}

/** One of the times the person can switch content logging on for. .NET: `ContentLoggingChoice`. */
export interface ContentLoggingChoice {
  readonly durationMs: number;
  /** "1 hour", "4 hours", "24 hours" in the app's language. */
  readonly text: string;
}

const HOUR = 60 * 60 * 1000;

function choicesFor(s: UiStrings): readonly ContentLoggingChoice[] {
  return Object.freeze([
    Object.freeze({ durationMs: HOUR, text: s.contentLoggingOneHour }),
    Object.freeze({ durationMs: 4 * HOUR, text: s.contentLoggingFourHours }),
    Object.freeze({ durationMs: 24 * HOUR, text: s.contentLoggingDay }),
  ]);
}

export interface ContentLoggingOptions {
  /** The agent whose content logging it is. Give this or `source`. */
  agent?: FadenstackAgent;
  /** Where the state comes from and goes to (a test's). */
  source?: ContentLoggingSource;
  /** The texts; English by default. */
  strings?: StringsSource;
  /** The time now in milliseconds, to say whether the end is today; the system clock by default. */
  now?: () => number;
}

function sourceOf(options: ContentLoggingOptions): ContentLoggingSource {
  if (!options.agent && !options.source) throw new TypeError("Give an agent or a source.");
  return options.source ?? contentLoggingSource(options.agent!);
}

/**
 * The setting for content logging, for an app's settings page (8.1): only when the app offers it and the machine policy allows it
 * (`isAvailable`), a choice of 1 hour, 4 hours or 24 hours, Start and Stop, the end time while it is on, and a sentence saying what is
 * logged and that it ends by itself. The band in the chat (`ContentLoggingBandViewModel`) shows it while it is on. A skin binds to this class
 * and holds no logic: the texts come from `strings` (say them again on `retext()`). Call `dispose()` when the page goes. .NET:
 * `ContentLoggingSettingsViewModel`.
 */
export class ContentLoggingSettingsViewModel extends Observable {
  readonly #source: ContentLoggingSource;
  readonly #strings: StringsSource;
  readonly #now: () => number;
  readonly #stop: () => void;
  #selected = 0;

  constructor(options: ContentLoggingOptions) {
    super();
    this.#source = sourceOf(options);
    this.#strings = options.strings ?? (() => englishStrings);
    this.#now = options.now ?? (() => Date.now());
    this.#stop = this.#source.onChanged(() => this.notify());
  }

  /** The texts the view model was given. */
  get strings(): UiStrings {
    return this.#strings();
  }

  /** The app offers content logging and the policy allows it: the control shows only then. */
  get isAvailable(): boolean {
    return this.#source.canStart;
  }

  /** Content logging is on now. */
  get isOn(): boolean {
    return this.#source.isOn;
  }

  /** The times to choose from: 1 hour, 4 hours, 24 hours. */
  get choices(): readonly ContentLoggingChoice[] {
    return choicesFor(this.strings);
  }

  /** The index of the time chosen in `choices`; the first (one hour) at first. */
  get selectedIndex(): number {
    return this.#selected;
  }

  set selectedIndex(value: number) {
    if (!Number.isInteger(value) || value < 0 || value >= this.choices.length || value === this.#selected) return;
    this.#selected = value;
    this.notify();
  }

  /** The choice can be changed and Start pressed: available and off. */
  get canStart(): boolean {
    return this.isAvailable && !this.isOn;
  }

  /** Stop can be pressed: it is on. */
  get canStop(): boolean {
    return this.isOn;
  }

  /** "On until 14:30." while it is on; empty when off. */
  get onUntilText(): string {
    const until = this.#source.until;
    return this.#source.isOn && until !== undefined ? this.strings.contentLoggingOnUntil(contentLoggingTime(until, this.#now(), this.strings.language)) : "";
  }

  /** What is logged, and that it ends by itself. */
  get introText(): string {
    return this.strings.contentLoggingIntro;
  }

  /** Switches it on for the chosen time (Start). Does nothing when it cannot be started. */
  start(): void {
    if (!this.canStart) return;
    try {
      this.#source.start(this.choices[this.#selected]?.durationMs ?? CONTENT_LOGGING_DEFAULT_MS);
    } catch (error) {
      if (!(error instanceof ContentLoggingError)) throw error;
      this.notify(); // the app's offer or the policy changed under the control: it shows what is true now
    }
  }

  /** Switches it off (Stop). */
  stop(): void {
    this.#source.stop();
  }

  /** The app's language changed: every text is said again. */
  retext(): void {
    this.notify();
  }

  /** Stops watching the source. */
  dispose(): void {
    this.#stop();
  }
}

/**
 * The band in the chat while content logging is on (8.1): "Content logging is on until 14:30. Prompts and answers are written to the
 * app's logs." with a Stop button. It shows only while content logging is on, so it is the person's reminder that it is. The chat view
 * model has one (`chat.contentLogging`); a host with its own chat surface can make its own. .NET: `ContentLoggingBandViewModel`.
 */
export class ContentLoggingBandViewModel extends Observable {
  readonly #source: ContentLoggingSource;
  readonly #strings: StringsSource;
  readonly #now: () => number;
  readonly #stop: () => void;

  constructor(options: ContentLoggingOptions) {
    super();
    this.#source = sourceOf(options);
    this.#strings = options.strings ?? (() => englishStrings);
    this.#now = options.now ?? (() => Date.now());
    this.#stop = this.#source.onChanged(() => this.notify());
  }

  /** Content logging is on: the band shows. */
  get isShown(): boolean {
    return this.#source.isOn;
  }

  /** "Content logging is on until 14:30. Prompts and answers are written to the app's logs."; empty while off. */
  get text(): string {
    const until = this.#source.until;
    const s = this.#strings();
    return this.#source.isOn && until !== undefined ? s.contentLoggingBand(contentLoggingTime(until, this.#now(), s.language)) : "";
  }

  /** "Stop". */
  get stopText(): string {
    return this.#strings().markerStop;
  }

  /** "Stop content logging", the button's name for a screen reader. */
  get stopName(): string {
    return this.#strings().contentLoggingStopName;
  }

  /** Stop: switches content logging off. */
  stop(): void {
    this.#source.stop();
  }

  /** The app's language changed: every text is said again. */
  retext(): void {
    this.notify();
  }

  /** Stops watching the source. */
  dispose(): void {
    this.#stop();
  }
}
