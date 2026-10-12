import { MAX_EVENTS_PER_REPORT, type AgentClientEvent, type FadenClient } from "@fadenstack/client";

/**
 * Tells the server what happened on the device -- tool runs, approvals, session counts -- as names, durations
 * and outcomes, never content. Sent after each turn; a report that fails is dropped, never the turn.
 */
export class EventReporter {
  readonly #client: FadenClient;
  readonly #enabled: boolean;
  #pending: AgentClientEvent[] = [];
  #flushing: Promise<void> = Promise.resolve();

  /** The last report that failed, for diagnostics. */
  lastError: unknown;

  constructor(client: FadenClient, enabled: boolean) {
    this.#client = client;
    this.#enabled = enabled && client.agent !== undefined;
  }

  add(event: AgentClientEvent): void {
    if (this.#enabled) this.#pending.push(event);
  }

  /** Sends what is waiting, in batches the server takes. Reports run one after another. */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(async () => {
      while (this.#pending.length) {
        const batch = this.#pending.splice(0, MAX_EVENTS_PER_REPORT);
        await this.#send(batch);
      }
    });
    return this.#flushing;
  }

  /** Reports at once (a module's event), outside the turn's batch. */
  reportNow(events: readonly AgentClientEvent[]): Promise<void> {
    return this.#enabled ? this.#send(events) : Promise.resolve();
  }

  async #send(events: readonly AgentClientEvent[]): Promise<void> {
    try {
      await this.#client.agent!.report(events, AbortSignal.timeout(30_000));
    } catch (error) {
      this.lastError = error;
    }
  }
}
