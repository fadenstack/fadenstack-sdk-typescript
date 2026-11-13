import {
  ApprovalDecision,
  GrantAnswer,
  openInBrowser,
  type ApprovalHandler,
  type ApprovalRequest,
  type GrantHandler,
  type GrantOffer,
  type StepUpHandler,
  type StepUpRequest,
  type StepUpStage,
} from "@fadenstack/agents";

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
 * A grant card waiting for the person: the work card, the extension card or the Bypass confirmation. Resolved by the
 * card's buttons. .NET: `Fadenstack.UI.Services.PendingGrant`.
 */
export class PendingGrant {
  readonly offer: GrantOffer;
  /** Aborted when the turn is stopped or the wait runs out. */
  readonly signal: AbortSignal;
  readonly answer: Promise<GrantAnswer>;
  #resolve!: (answer: GrantAnswer) => void;
  #settled = false;
  #claimed = false;

  constructor(offer: GrantOffer, signal: AbortSignal) {
    this.offer = offer;
    this.signal = signal;
    this.answer = new Promise<GrantAnswer>((resolve, reject) => {
      this.#resolve = resolve;
      signal.addEventListener("abort", () => {
        if (!this.#settled) {
          this.#settled = true;
          reject(signal.reason);
        }
      }, { once: true });
    });
    this.answer.catch(() => undefined);
  }

  get isResolved(): boolean {
    return this.#settled;
  }

  /** Whether a chat took the card to draw (a Bypass confirmation is drawn only by its conversation's chat). */
  get isClaimed(): boolean {
    return this.#claimed;
  }

  /** A chat draws this card: call it from `onGrantRequested`, before it returns. */
  claim(): void {
    this.#claimed = true;
  }

  /** The person's answer; false when it came too late. */
  resolve(answer: GrantAnswer): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    this.#resolve(answer);
    return true;
  }
}

/**
 * The agent's approval handler for a UI: each request becomes a card in the chat, and the user's click is the answer --
 * an approval card, a grant card to work alongside the person (`GrantHandler`), the Bypass confirmation, and the
 * second sign-in's page and states (`StepUpHandler`). Give the same broker to the builder and to the chat view model.
 * Without a chat listening, requests are declined. .NET: `Fadenstack.UI.Services.ApprovalBroker`.
 */
export class ApprovalBroker implements ApprovalHandler, GrantHandler, StepUpHandler {
  readonly #listeners = new Set<{ listener: (pending: PendingApproval) => void; session: (() => string | undefined) | undefined }>();
  readonly #grantListeners = new Set<(pending: PendingGrant) => void>();
  readonly #stepUpListeners = new Set<(request: StepUpRequest, stage: StepUpStage) => void>();

  /**
   * Opens a page in the person's browser; false when it could not. A new tab of the browser (never an iframe, no
   * opener) unless an app (an extension, a shell) or a test sets its own.
   */
  openBrowser: (link: URL) => boolean = openInBrowser;

  /**
   * Calls `listener` for each request; returns the unsubscribe. A chat gives `session`, the id of the session it shows
   * now: it then gets only the requests of that session (and those that name none), so several chats share one broker.
   * A listener without `session` gets every request.
   */
  onRequested(listener: (pending: PendingApproval) => void, session?: () => string | undefined): () => void {
    const entry = { listener, session };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /**
   * Calls `listener` for each grant card to show (`ChatSession.offerWork`, an extension) and for the Bypass
   * confirmation (`offer.bypass`), which only the chat of its conversation draws: it `claim()`s it.
   */
  onGrantRequested(listener: (pending: PendingGrant) => void): () => void {
    this.#grantListeners.add(listener);
    return () => {
      this.#grantListeners.delete(listener);
    };
  }

  /** Calls `listener` as the second sign-in stands: in the browser, approved, denied, timed out, failed or cancelled. */
  onStepUpChanged(listener: (request: StepUpRequest, stage: StepUpStage) => void): () => void {
    this.#stepUpListeners.add(listener);
    return () => {
      this.#stepUpListeners.delete(listener);
    };
  }

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const owners = [...this.#listeners].filter((l) => !l.session || !request.sessionId || l.session() === request.sessionId);
    if (owners.length === 0) return Promise.resolve(ApprovalDecision.deny("Nobody is here to approve it."));
    const pending = new PendingApproval(request, signal);
    for (const { listener } of owners) listener(pending);
    return pending.decision;
  }

  requestGrant(offer: GrantOffer, signal: AbortSignal): Promise<GrantAnswer> {
    if (this.#grantListeners.size === 0) return Promise.resolve(GrantAnswer.notNow);
    const pending = new PendingGrant(offer, signal);
    for (const listener of [...this.#grantListeners]) listener(pending);
    // No chat of its conversation draws a Bypass confirmation: nobody can confirm it (sdk/09 L-58).
    if (offer.bypass && !pending.isClaimed) return Promise.resolve(GrantAnswer.notNow);
    return pending.answer;
  }

  open(request: StepUpRequest): Promise<boolean> {
    return Promise.resolve(this.openBrowser(request.link));
  }

  report(request: StepUpRequest, stage: StepUpStage): void {
    for (const listener of [...this.#stepUpListeners]) listener(request, stage);
  }
}
