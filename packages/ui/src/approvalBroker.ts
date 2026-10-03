import { ApprovalDecision, type ApprovalHandler, type ApprovalRequest } from "@fadenstack/agents";

/** A call waiting for the user; resolved by the approval card's buttons. */
export class PendingApproval {
  readonly request: ApprovalRequest;
  /** Aborted when the turn is stopped or the wait runs out. */
  readonly signal: AbortSignal;
  readonly decision: Promise<ApprovalDecision>;
  #resolve!: (decision: ApprovalDecision) => void;
  #settled = false;

  constructor(request: ApprovalRequest, signal: AbortSignal) {
    this.request = request;
    this.signal = signal;
    this.decision = new Promise<ApprovalDecision>((resolve, reject) => {
      this.#resolve = resolve;
      signal.addEventListener("abort", () => {
        if (!this.#settled) {
          this.#settled = true;
          reject(signal.reason);
        }
      }, { once: true });
    });
    this.decision.catch(() => undefined); // nobody may be waiting once it was stopped
  }

  get isResolved(): boolean {
    return this.#settled;
  }

  /** The user's answer; false when it came too late. */
  resolve(decision: ApprovalDecision): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    this.#resolve(decision);
    return true;
  }
}

/**
 * The agent's approval handler for a UI: each request becomes an approval card in the chat, and the user's
 * click is the decision. Give the same broker to the builder and to the chat view model. Without a chat
 * listening, requests are declined.
 */
export class ApprovalBroker implements ApprovalHandler {
  readonly #listeners = new Set<(pending: PendingApproval) => void>();

  /** Calls `listener` for each request; returns the unsubscribe. */
  onRequested(listener: (pending: PendingApproval) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.#listeners.size === 0) return Promise.resolve(ApprovalDecision.deny("Nobody is here to approve it."));
    const pending = new PendingApproval(request, signal);
    for (const listener of [...this.#listeners]) listener(pending);
    return pending.decision;
  }
}
