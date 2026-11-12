import {
  BypassSignInError,
  GrantAnswer,
  REASON_LENGTH,
  cutReason,
  type GrantOffer,
  type GrantPlace,
  type StepUpRequest,
  type StepUpStage,
} from "@fadenstack/agents";
import { FadenstackApiError, FadenstackError, FadenstackPermissionError } from "@fadenstack/client";

import type { PendingGrant } from "./approvalBroker.js";
import { Observable } from "./observable.js";
import { evidenceLevel, grantMay, period } from "./period.js";
import { ResponsePart, type PartContext } from "./parts.js";

/** A time to pick on a card: the milliseconds, and how the card says it ("30 min"; for an extension "30 min longer"). */
export interface DurationOption {
  value: number;
  label: string;
}

export type GrantCardState = "pending" | "allowed" | "declined";

/** A place on the grant card the person may take out before allowing. */
export class GrantPlaceItem extends Observable {
  readonly place: GrantPlace;
  readonly #isPending: () => boolean;
  #kept = true;

  constructor(place: GrantPlace, isPending: () => boolean) {
    super();
    this.place = place;
    this.#isPending = isPending;
  }

  get label(): string {
    return this.place.label;
  }

  /** Whether the place stays in the grant. */
  get kept(): boolean {
    return this.#kept;
  }

  /** Takes the place out, or puts it back; only while the card waits. */
  toggle(): void {
    if (!this.#isPending()) return;
    this.#kept = !this.#kept;
    this.notify();
  }
}

/**
 * The grant card (desktop 37 §5.3, 38 §7): "Work alongside you?", the places (each can be taken out), the time, what the
 * agent may do without asking and what still asks; for an extension only the difference. Drawn from the places and the
 * classes the app gives, never from the model's words. Allow sends what the person kept; the server's answer is the
 * grant. .NET: `Fadenstack.UI.Parts.GrantPart`.
 */
export class GrantPart extends ResponsePart {
  readonly kind = "grant";
  readonly places: readonly GrantPlaceItem[];
  readonly #context: PartContext;
  readonly #pending: PendingGrant;
  #duration: number | undefined;
  #state: GrantCardState = "pending";

  constructor(context: PartContext, pending: PendingGrant) {
    super();
    this.#context = context;
    this.#pending = pending;
    this.places = pending.offer.places.map(place => {
      const item = new GrantPlaceItem(place, () => this.isPending);
      item.subscribe(() => this.notify());
      return item;
    });
    const offer = pending.offer;
    this.#duration = offer.durations.includes(offer.preselected) ? offer.preselected : offer.durations[0];
    pending.signal.addEventListener("abort", () => this.#withdrawn(), { once: true });
  }

  get offer(): GrantOffer {
    return this.#pending.offer;
  }

  /** The conversation the card is for; undefined when it was offered before one existed. */
  get conversationId(): string | undefined {
    return this.offer.conversationId;
  }

  /** Whether the card extends a running grant (it shows only what it adds). */
  get isExtension(): boolean {
    return this.offer.extending !== undefined;
  }

  get title(): string {
    return this.isExtension ? this.#context.strings.grantExtendTitle : this.#context.strings.grantTitle;
  }

  get placesHeading(): string {
    return this.isExtension ? this.#context.strings.grantNewPlaces : this.#context.strings.grantPlaces;
  }

  get hasPlaces(): boolean {
    return this.places.length > 0;
  }

  get durationLabel(): string {
    return this.#context.strings.grantDuration;
  }

  /** The times to pick from; for an extension, how much longer. */
  get durations(): readonly DurationOption[] {
    const s = this.#context.strings;
    return this.offer.durations.map(value => ({
      value, label: this.isExtension ? s.grantMoreTime(period(s, value)) : period(s, value),
    }));
  }

  /** The time picked, in milliseconds. */
  get selectedDuration(): number | undefined {
    return this.#duration;
  }

  /** Picks a time among the offer's; only while the card waits. */
  selectDuration(value: number): void {
    if (!this.isPending || !this.offer.durations.includes(value) || this.#duration === value) return;
    this.#duration = value;
    this.notify();
  }

  get mayText(): string {
    return grantMay(this.#context.strings, this.offer.classes);
  }

  get stillAsksText(): string {
    return this.#context.strings.grantStillAsks;
  }

  /** The app's reason, if it gave one. */
  get reason(): string {
    return this.offer.reason ?? "";
  }

  get allowText(): string { return this.#context.strings.grantAllow; }
  get notNowText(): string { return this.#context.strings.grantNotNow; }
  get removeText(): string { return this.#context.strings.grantRemovePlace; }
  get addBackText(): string { return this.#context.strings.grantKeepPlace; }

  /** The buttons in the order a skin draws them: Not now first. */
  readonly buttons: readonly ("notNow" | "allow")[] = Object.freeze(["notNow", "allow"] as const);

  get state(): GrantCardState {
    return this.#state;
  }

  get isPending(): boolean {
    return this.#state === "pending";
  }

  get stateText(): string {
    const s = this.#context.strings;
    return this.#state === "allowed" ? s.grantAllowed : this.#state === "declined" ? s.grantDeclined : "";
  }

  /** The card's text as the person sees it now: its SHA-256 goes to the server as evidence. */
  get shownText(): string {
    const kept = this.places.filter(p => p.kept).map(p => p.label).join(" · ");
    const duration = this.durations.find(d => d.value === this.#duration)?.label ?? "";
    return [this.title, duration, this.hasPlaces ? `${this.placesHeading} ${kept}` : "", this.mayText, this.stillAsksText]
      .filter(line => line.length > 0).join("\n");
  }

  get canAllow(): boolean {
    return this.isPending && this.#duration !== undefined && (this.isExtension || this.places.some(p => p.kept));
  }

  /** Allow: sends the places kept and the time picked. */
  allow(): void {
    if (!this.canAllow) return;
    const kept = this.places.filter(p => p.kept).map(p => p.place);
    this.#answer({ allowed: true, places: kept, duration: this.#duration!, shownText: this.shownText }, "allowed");
  }

  notNow(): void {
    if (this.isPending) this.#answer(GrantAnswer.notNow, "declined");
  }

  #answer(answer: GrantAnswer, state: GrantCardState): void {
    if (this.#pending.resolve(answer)) {
      this.#state = state;
      this.notify();
    }
  }

  // The turn was stopped or the wait ran out: nothing came of it.
  #withdrawn(): void {
    if (this.#state !== "pending") return;
    this.#state = "declined";
    this.notify();
  }
}

/**
 * Where the Bypass card stands: `pending` (waiting for the person's click), `confirming` (allowed; the server has not
 * answered), `signing_in` (the second sign-in runs in the browser, sdk/41), `on` (the server confirmed it), `not_confirmed`
 * (no acknowledgement: offline, refused, switched off; no Bypass, sdk/09 L-59), `declined`.
 */
export type BypassCardState = "pending" | "confirming" | "signing_in" | "on" | "not_confirmed" | "declined";

/** Why Bypass is not on, as far as the card can tell; undefined: not known. */
export type BypassFailure = "refused" | "offline" | "unavailable" | "denied" | "timed_out" | "no_browser";

/**
 * The Bypass confirmation (sdk/09 L-58, sdk/40 A3.3): what will no longer be asked in this chat, what still asks, what
 * the server records of each call (from the profile's `approvals.bypass.evidence`), for how long -- the shortest time
 * first, no extension -- and an optional reason that administrators see. Drawn from the offer, never from the model's words.
 *
 * Deliberate: only the person's click on Allow answers it. Allow is not the default button (Not now comes first and takes
 * the focus), Enter and Escape never switch Bypass on (`ignoresKey`), nothing answers it on a timer. After the click the
 * card waits for the server: Bypass holds only once the server confirmed it, and that needs a second sign-in in the
 * browser (`signing_in`), which the app opens and the person approves there; without that the card says so
 * (`not_confirmed`) and the chat stays as it was (L-59). .NET: `Fadenstack.UI.Parts.BypassPart`.
 */
export class BypassPart extends ResponsePart {
  readonly kind = "bypass";
  /** The buttons in the order a skin draws them: Not now first, then the switch. */
  readonly buttons: readonly ("notNow" | "allow")[] = Object.freeze(["notNow", "allow"] as const);
  /** The button that takes the focus when the card shows: never Allow. */
  readonly initialFocus: "notNow" = "notNow";
  /** The keys that never press Allow (or "Open the page again"), even when it has the focus: a skin prevents their default. */
  static readonly ignoredKeys: readonly string[] = Object.freeze(["Enter", "Escape"]);
  readonly #context: PartContext;
  readonly #pending: PendingGrant;
  readonly #openBrowser: (link: URL) => boolean;
  #request: StepUpRequest | undefined;
  #duration: number | undefined;
  #state: BypassCardState = "pending";
  #closed = false;
  #reason = "";
  #failure: BypassFailure | undefined;

  constructor(context: PartContext, pending: PendingGrant, openBrowser: (link: URL) => boolean) {
    super();
    this.#context = context;
    this.#pending = pending;
    this.#openBrowser = openBrowser;
    const offer = pending.offer;
    this.#duration = offer.durations.includes(offer.preselected) ? offer.preselected : offer.durations[0];
  }

  get offer(): GrantOffer { return this.#pending.offer; }
  get conversationId(): string | undefined { return this.offer.conversationId; }
  get title(): string { return this.#context.strings.bypassTitle; }
  get noLongerAsksText(): string { return this.#context.strings.bypassNoLongerAsks; }
  get stillAsksText(): string { return this.#context.strings.bypassStillAsks; }
  /** What the server records of each call, as the profile says it (sdk/40 A4 decision 6). */
  get recordsText(): string { return this.#context.strings.bypassRecords[evidenceLevel(this.offer.evidence)]; }
  get durationLabel(): string { return this.#context.strings.grantDuration; }
  get noExtensionText(): string { return this.#context.strings.bypassNoExtension; }
  get reasonLabel(): string { return this.#context.strings.bypassReason; }
  get reasonSeenText(): string { return this.#context.strings.bypassReasonSeen; }
  get allowText(): string { return this.#context.strings.bypassAllow; }
  get notNowText(): string { return this.#context.strings.grantNotNow; }
  get closeText(): string { return this.#context.strings.close; }
  /** The app's own reason for offering it, if it gave one (its text, never the model's). */
  get appReason(): string { return this.offer.reason ?? ""; }

  /** The times to pick from: the offer's, up to the longest the server allows. */
  get durations(): readonly DurationOption[] {
    const s = this.#context.strings;
    return this.offer.durations.map(value => ({ value, label: period(s, value) }));
  }

  get selectedDuration(): number | undefined { return this.#duration; }

  selectDuration(value: number): void {
    if (!this.isPending || !this.offer.durations.includes(value) || this.#duration === value) return;
    this.#duration = value;
    this.notify();
  }

  /** The person's own words on why (optional), at most `reasonLength` characters. */
  get reason(): string { return this.#reason; }
  set reason(text: string) {
    if (!this.isPending) return;
    const cut = cutReason(text) ?? "";
    if (cut === this.#reason) return;
    this.#reason = cut;
    this.notify();
  }

  get reasonLength(): number { return REASON_LENGTH; }

  get state(): BypassCardState { return this.#state; }
  get isPending(): boolean { return this.#state === "pending"; }
  get isNotConfirmed(): boolean { return this.#state === "not_confirmed"; }
  /** Whether the second sign-in runs in the browser: the card shows the code and "Open the page again". */
  get isSigningIn(): boolean { return this.#state === "signing_in"; }

  /** Whether the card shows: waiting for the person or the server, or saying that Bypass is not on until closed. */
  get isShown(): boolean {
    return this.#state === "pending" || this.#state === "confirming" || this.#state === "signing_in"
      || (this.#state === "not_confirmed" && !this.#closed);
  }

  get signInText(): string { return this.#context.strings.bypassSignIn; }

  /** "The page shows the code ABCD-EFGH.", so the person can compare it; empty when the request has none. */
  get signInCodeText(): string {
    return this.#request?.userCode ? this.#context.strings.bypassSignInCode(this.#request.userCode) : "";
  }

  get openAgainText(): string { return this.#context.strings.bypassOpenAgain; }
  get openAgainName(): string { return this.#context.strings.bypassOpenAgainName; }
  get canOpenAgain(): boolean { return this.#state === "signing_in" && this.#request !== undefined; }

  /** Opens the second sign-in's page in the browser again (the first one was closed, or went to another window). */
  openAgain(): void {
    if (this.canOpenAgain) this.#openBrowser(this.#request!.link);
  }

  get stateText(): string {
    const s = this.#context.strings;
    switch (this.#state) {
      case "confirming": return s.bypassConfirming;
      case "signing_in": return s.bypassSignIn;
      case "on": return s.bypassOn;
      case "not_confirmed": return this.#failure ? s.bypassNotConfirmed[this.#failure] : s.bypassNotConfirmedUnknown;
      case "declined": return s.grantDeclined;
      default: return "";
    }
  }

  /** Whether `key` never presses Allow, even a focused one: Enter and Escape never switch Bypass on. */
  ignoresKey(key: string): boolean {
    return BypassPart.ignoredKeys.includes(key);
  }

  /** The card's text as the person sees it now: its SHA-256 goes to the server as evidence. */
  get shownText(): string {
    const duration = this.durations.find(d => d.value === this.#duration)?.label ?? "";
    return [this.title, this.appReason, this.noLongerAsksText, this.stillAsksText, this.recordsText,
      `${this.durationLabel} ${duration}`, this.noExtensionText, this.reasonSeenText].filter(line => line.length > 0).join("\n");
  }

  get canAllow(): boolean { return this.isPending && this.#duration !== undefined; }

  /** Switches Bypass on for the picked time: the person's click, and only that. */
  allow(): void {
    if (!this.canAllow) return;
    const reason = this.#reason.trim();
    this.#answer({ allowed: true, places: [], duration: this.#duration!, shownText: this.shownText, ...(reason ? { reason } : {}) }, "confirming");
  }

  notNow(): void {
    if (this.isPending) this.#answer(GrantAnswer.notNow, "declined");
  }

  /** Takes away the card that says Bypass is not on. */
  get canClose(): boolean { return this.#state === "not_confirmed" && !this.#closed; }
  close(): void {
    if (!this.canClose) return;
    this.#closed = true;
    this.notify();
  }

  /** @internal The server confirmed it. */
  confirmed(): void {
    if (this.#state === "confirming" || this.#state === "signing_in") this.#set("on");
  }

  /**
   * @internal How the second sign-in stands (sdk/41): in the browser, approved (the server is asked now), or why it came to
   * nothing. A report that arrives before the click's own state is set still counts once the card is answered.
   */
  stepUp(request: StepUpRequest, stage: StepUpStage): void {
    if (!this.waiting) return;
    switch (stage) {
      case "browser": this.#request = request; this.#set("signing_in"); break;
      case "approved": this.#set("confirming"); break;
      case "denied": this.#fail("denied"); break;
      case "timed_out": this.#fail("timed_out"); break;
      case "failed": this.#fail("no_browser"); break;
      case "cancelled": this.withdrawn(); break;
    }
  }

  /** @internal The server gave no acknowledgement: the card says why, as far as it can tell, and stays until closed. */
  notConfirmed(error: unknown): void {
    if (error instanceof BypassSignInError && error.stage === "cancelled") return this.withdrawn();
    this.#failure = failureOf(error);
    this.#set("not_confirmed");
  }

  /** @internal Nothing came of it (the offer was withdrawn, the turn stopped, the chat left): the card goes. */
  withdrawn(): void {
    if (this.#state === "pending" || this.#state === "confirming" || this.#state === "signing_in") this.#set("declined");
  }

  /** @internal Allowed and waiting for the browser or the server (the state itself is set just after the click is passed on). */
  get waiting(): boolean {
    return this.#state === "confirming" || this.#state === "signing_in" || (this.#state === "pending" && this.#pending.isResolved);
  }

  #fail(why: BypassFailure): void {
    this.#failure = why;
    this.#set("not_confirmed");
  }

  #set(state: BypassCardState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.notify();
  }

  #answer(answer: GrantAnswer, state: BypassCardState): void {
    if (this.#pending.resolve(answer) && this.#state === "pending") this.#set(state); // a report of the sign-in may have come first
  }
}

// Why the server gave no acknowledgement, as far as the error tells.
function failureOf(error: unknown): BypassFailure | undefined {
  if (error instanceof BypassSignInError) {
    return error.stage === "denied" ? "denied" : error.stage === "timed_out" ? "timed_out" : "no_browser";
  }
  if (error instanceof FadenstackApiError) {
    if (error.code === "grant_limits_unavailable") return "unavailable";
    if (error.code === "bypass_not_allowed" || error.code === "grant_not_offered" || error instanceof FadenstackPermissionError) return "refused";
    return undefined;
  }
  if (error instanceof FadenstackError || error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) return "offline";
  return undefined;
}
