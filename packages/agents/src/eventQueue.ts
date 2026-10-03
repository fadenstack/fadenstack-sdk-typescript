/** An unbounded queue read as an async iterator: one writer pushes, one reader takes, in order. */
export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #failWaiting: ((error: unknown) => void) | undefined;
  #ended = false;
  #error: unknown;
  #hasError = false;

  push(item: T): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = this.#failWaiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  /** No more items; with an error, the reader gets it after the items already queued. */
  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    if (arguments.length > 0 && error !== undefined) {
      this.#error = error;
      this.#hasError = true;
    }
    if (this.#waiting && this.#items.length === 0) {
      const resolve = this.#waiting;
      const fail = this.#failWaiting!;
      this.#waiting = this.#failWaiting = undefined;
      if (this.#hasError) fail(this.#error);
      else resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift()!, done: false });
        if (this.#ended) return this.#hasError ? Promise.reject(this.#error) : Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiting = resolve;
          this.#failWaiting = reject;
        });
      },
    };
  }
}
