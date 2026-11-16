import type { ContentLoggingSource } from "@fadenstack/ui";

// A content logging state for the setting and the band to show, and what was started: for the view models' and the skins' tests.

export class FakeContentLogging implements ContentLoggingSource {
  canStart: boolean;
  isOn: boolean;
  until: number | undefined;
  readonly started: number[] = [];
  stops = 0;
  readonly #listeners = new Set<() => void>();

  constructor(canStart: boolean, isOn = false, until?: number) {
    this.canStart = canStart;
    this.isOn = isOn;
    this.until = until;
  }

  start(durationMs: number): void {
    this.started.push(durationMs);
    this.isOn = true;
    this.until = Date.now() + durationMs;
    this.#changed();
  }

  stop(): void {
    this.stops += 1;
    this.isOn = false;
    this.until = undefined;
    this.#changed();
  }

  /** The time ran out by itself. */
  endByItself(): void {
    this.isOn = false;
    this.until = undefined;
    this.#changed();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The states the setting shows, by name. */
export const STATES = {
  off: () => new FakeContentLogging(true),
  on: () => new FakeContentLogging(true, true, Date.now() + 90 * 60 * 1000),
  unavailable: () => new FakeContentLogging(false),
} as const;
