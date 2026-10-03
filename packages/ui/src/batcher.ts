import type { UiScheduler } from "./services.js";

interface TextOp {
  target: object;
  text: string;
  apply: (text: string) => void;
}

/**
 * Applies the agent's events to the view models in batches: at most one flush per interval, however fast they
 * come. Consecutive text for the same target is merged into one append, so a fast stream costs one update per
 * frame, not one per token. Order is kept.
 */
export class RenderBatcher {
  readonly #scheduler: UiScheduler;
  readonly #intervalMs: number;
  #queue: (TextOp | (() => void))[] = [];
  #scheduled = false;

  constructor(scheduler: UiScheduler, intervalMs: number) {
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }

  enqueue(action: () => void): void {
    this.#queue.push(action);
    this.#schedule();
  }

  /** Appends `text` for `target`, merged with text already waiting for it. */
  enqueueText(target: object, text: string, apply: (text: string) => void): void {
    const last = this.#queue[this.#queue.length - 1];
    if (last && typeof last !== "function" && last.target === target) {
      last.text += text;
      return;
    }
    this.#queue.push({ target, text, apply });
    this.#schedule();
  }

  /** Settles once everything queued before it has been applied. */
  whenFlushed(): Promise<void> {
    return new Promise<void>((resolve) => this.enqueue(resolve));
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#scheduler.schedule(() => this.#flush(), this.#intervalMs);
  }

  #flush(): void {
    const batch = this.#queue;
    this.#queue = [];
    this.#scheduled = false;
    for (const op of batch) {
      if (typeof op === "function") op();
      else op.apply(op.text);
    }
  }
}
