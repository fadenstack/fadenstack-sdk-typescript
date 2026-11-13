import {
  GrantLifecycle,
  type ChatSession,
  type FadenstackAgent,
  type GrantEnded,
} from "@fadenstack/agents";
import type { AgentGrant } from "@fadenstack/client";

import type { ApprovalBroker, PendingGrant } from "./approvalBroker.js";
import { BypassPart, GrantPart } from "./grantCards.js";
import { Observable } from "./observable.js";
import { evidenceLevel, period, shortPlace } from "./period.js";
import type { PartContext } from "./parts.js";
import type { UiStrings } from "./strings.js";

/** The server's code when an extension would pass the longest grant from its start. */
export const AT_LONGEST_CODE = "grant_at_longest";

const KEEP_GOING_BY = GrantLifecycle.KEEP_GOING_BY;
const ENDING_SOON = GrantLifecycle.ENDING_SOON_BEFORE;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** One line of Settings -> Approvals: a grant the server holds, or a tool allowed always on this device. */
export class StandingApprovalItem {
  /** A running Bypass (a skin may mark it as such). */
  readonly isBypass: boolean;
  readonly title: string;
  readonly #revoke: () => Promise<void>;

  constructor(title: string, revoke: () => Promise<void>, isBypass = false) {
    this.title = title;
    this.#revoke = revoke;
    this.isBypass = isBypass;
  }

  /** Ends the grant on the server, or forgets the tool's "always". */
  revoke(): Promise<void> {
    return this.#revoke();
  }
}

/** What a chat needs of its host. */
export interface GrantsHost {
  /** Stops the running turn. */
  stopTurn(): void;
  /** The chat's session, once it has one. */
  session(): ChatSession | undefined;
  /** Asks for Bypass again (the confirmation, then the second sign-in). */
  switchOnAgain(): Promise<unknown>;
}

/**
 * What the person let the agent do for longer than one call (sdk/38 §7), for one chat: the grant cards, the marker while
 * a stretch of work runs (the time left by the server's clock, Stop, and near the end "another 30 min"), the Bypass
 * confirmation and its marker while the chat runs in Bypass (the time left, what is recorded, Stop; never more time;
 * sdk/09 L-58, L-63), "Bypass ended" with its reason and "Switch on again", and Settings -> Approvals with Revoke. The
 * server holds the grants; this shows the agent's copy (`agent.grants`). .NET: `Fadenstack.UI.ViewModels.GrantsViewModel`.
 */
export class GrantsViewModel extends Observable {
  /** How often the markers look again (the time left, paused, ending). */
  static readonly TICK_EVERY = 15_000;
  /** How often the copy is read from the server while a Bypass runs, so a server's end shows (L-63). */
  static readonly BYPASS_REFRESH = 30_000;

  readonly #agent: FadenstackAgent;
  readonly #broker: ApprovalBroker;
  readonly #context: PartContext;
  readonly #host: GrantsHost;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #bypassEndedListeners = new Set<() => void>();
  readonly #tickedListeners = new Set<() => void>();
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  #cards: readonly GrantPart[] = [];
  #bypassCard: BypassPart | undefined;
  #work: AgentGrant | undefined;
  #markerText = "";
  #ending = false;
  #bypass: AgentGrant | undefined;
  #bypassChat: string | undefined;
  #bypassText = "";
  #bypassRecorded = "";
  #bypassEnded = false;
  #bypassEndedWhy: string | null = null;
  #lastRefresh = 0;
  #problem = "";
  #standing: readonly StandingApprovalItem[] = [];
  #disposed = false;

  constructor(agent: FadenstackAgent, broker: ApprovalBroker, context: PartContext, host: GrantsHost, tickEvery: number = GrantsViewModel.TICK_EVERY) {
    super();
    this.#agent = agent;
    this.#broker = broker;
    this.#context = context;
    this.#host = host;
    this.#unsubscribe.push(
      broker.onGrantRequested(pending => this.#onGrantRequested(pending)),
      broker.onStepUpChanged((request, stage) => {
        const card = this.#bypassCard;
        if (card && (request.conversationId === undefined ? card.waiting : request.conversationId === card.conversationId)) card.stepUp(request, stage);
      }),
      agent.grants.onChanged(() => this.tick()),
    );
    if (tickEvery > 0) {
      this.#timer = setInterval(() => this.#onTimer(), tickEvery);
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  get #strings(): UiStrings { return this.#context.strings; }

  // -- the work grant's cards and marker -----------------------------------------------------------------------------

  /** The grant cards waiting for the person, and those answered (with their state). */
  get cards(): readonly GrantPart[] { return this.#cards; }

  /** Whether a stretch of work runs: the marker is shown. */
  get hasMarker(): boolean { return this.#work !== undefined; }

  /** "Working alongside you · 23 min left", or that it is paused. */
  get markerText(): string { return this.#markerText; }

  /** Whether the end is near: the marker offers "Another 30 min". */
  get isEnding(): boolean { return this.#ending; }

  get stopText(): string { return this.#strings.markerStop; }
  get keepGoingText(): string { return this.#strings.markerKeepGoing(period(this.#strings, KEEP_GOING_BY)); }

  /** What went wrong that the person should know -- Stop did not reach the server, more time was refused; empty when nothing. */
  get message(): string { return this.#problem; }
  dismissMessage(): void { this.#say(""); }

  /** Stops everything (desktop 37 §5.6): the turn, and every grant of this device for the agent. */
  async stop(): Promise<void> {
    this.#host.stopTurn();
    this.#say("");
    try {
      await this.#agent.grants.revokeAll();
    } catch {
      this.#say(this.#strings.grantsStopFailed);
    }
    this.tick();
  }

  /** Extends the running stretch of work by 30 minutes in one click, as far as the server allows. */
  async keepGoing(): Promise<void> {
    const work = this.#work;
    if (!work || !this.#ending) return;
    try {
      // The marker's button is the card for this: the same bounds, only more time (desktop 37 §5.6).
      await this.#agent.grants.extend(work.id, KEEP_GOING_BY, [], `${this.#markerText}\n${this.keepGoingText}`);
      this.#say("");
    } catch (error) {
      this.#say(codeOf(error) === AT_LONGEST_CODE ? this.#strings.grantsAtLongest : this.#strings.grantsExtendFailed);
    }
    this.tick();
  }

  // -- Bypass ----------------------------------------------------------------------------------------------------

  /**
   * The Bypass confirmation of this chat's conversation: waiting for the person, for the server, or saying that Bypass
   * is not on (`isShown`); undefined when none was asked for.
   */
  get bypassCard(): BypassPart | undefined { return this.#bypassCard; }

  /** Whether this chat runs in Bypass: its marker is shown (L-63). */
  get hasBypass(): boolean { return this.#bypass !== undefined; }

  /** "Bypass on · 12 min left", by the server's clock. */
  get bypassText(): string { return this.#bypassText; }

  /** What the server records of each call under the running Bypass, from its grant's evidence level. */
  get bypassRecordedText(): string { return this.#bypassRecorded; }

  get bypassStopName(): string { return this.#strings.bypassStopName; }

  /** Ends this chat's Bypass (its grant, from the next call on) and the turn; the chat goes back to its mode. */
  async stopBypass(): Promise<void> {
    this.#host.stopTurn();
    const session = this.#host.session();
    try {
      if (session) await session.stopBypass();
      else if (this.#bypass) await this.#agent.grants.revoke(this.#bypass.id);
    } catch {
      this.#say(this.#strings.grantsStopFailed);
    }
    this.tick();
  }

  /** Whether the chat says that its Bypass ended, and why (`bypassEndedText`). */
  get hasBypassEnded(): boolean { return this.#bypassEnded; }

  /** "Bypass ended: an administrator ended it. Approvals ask again.", from the grant's `revokedBy`. */
  get bypassEndedText(): string {
    if (!this.#bypassEnded) return "";
    const s = this.#strings;
    const why = this.#bypassEndedWhy;
    return why !== null && Object.hasOwn(s.bypassEnded, why) ? s.bypassEnded[why as keyof UiStrings["bypassEnded"]] : s.bypassEndedUnknown;
  }

  dismissBypassEnded(): void { this.#setEnded(false, null); }

  /** "Switch on again" on the line that says Bypass ended. */
  get switchOnAgainText(): string { return this.#strings.bypassSwitchOnAgain; }
  get switchOnAgainName(): string { return this.#strings.bypassSwitchOnAgainName; }
  get closeText(): string { return this.#strings.close; }

  /** Enabled while the line is there and the agent still offers Bypass. */
  get canSwitchOnAgain(): boolean { return this.#bypassEnded && this.#agent.bypassOffered; }

  /**
   * Asks for Bypass again: only the chat's own call (it opens the confirmation, whose Allow starts the second sign-in).
   * Nothing but this button's click calls it.
   */
  async switchOnAgain(): Promise<void> {
    if (this.canSwitchOnAgain) await this.#host.switchOnAgain();
  }

  /** @internal Raised when this chat's Bypass ended, whoever ended it: the chat leaves Bypass. */
  onBypassEnded(listener: () => void): () => void {
    this.#bypassEndedListeners.add(listener);
    return () => this.#bypassEndedListeners.delete(listener);
  }

  /** @internal Raised after each tick: the chat list brings its Bypass times up to date. */
  onTicked(listener: () => void): () => void {
    this.#tickedListeners.add(listener);
    return () => this.#tickedListeners.delete(listener);
  }

  // -- Settings -> Approvals -------------------------------------------------------------------------------------

  /** Settings -> Approvals: the grants the server holds and what was allowed always on this device. */
  get standing(): readonly StandingApprovalItem[] { return this.#standing; }
  get hasStanding(): boolean { return this.#standing.length > 0; }
  get standingTitle(): string { return this.#strings.settingsApprovals; }
  get standingEmpty(): string { return this.#strings.settingsApprovalsEmpty; }
  get revokeText(): string { return this.#strings.revoke; }

  /** Reads Settings -> Approvals again (when Settings opens). */
  async load(): Promise<void> {
    const grants = this.#agent.grants;
    const live = grants.available ? grants.live : [];
    let always: readonly { tool: string }[] = [];
    try {
      always = await this.#agent.listApprovals();
    } catch {
      // the list stays what the grants say
    }
    const s = this.#strings;
    const items: StandingApprovalItem[] = [];
    for (const grant of live) {
      const left = period(s, grants.remaining(grant));
      const title = grant.kind === "work"
        ? s.settingsGrantWork((grant.scope.targets ?? []).flatMap(t => t.identifiers).map(shortPlace).join(", "), left)
        : grant.kind === "bypass"
          ? s.settingsGrantBypass(left, s.bypassRecorded[evidenceLevel(grant.evidenceLevel)])
          : s.settingsGrantTime((grant.scope.tools ?? []).join(", "), left);
      items.push(new StandingApprovalItem(title, async () => {
        await grants.revoke(grant.id);
        await this.load();
      }, grant.kind === "bypass"));
    }
    for (const approval of always) {
      items.push(new StandingApprovalItem(s.settingsAlways(approval.tool), async () => {
        await this.#agent.resetApprovals(approval.tool);
        await this.load();
      }));
    }
    this.#standing = items;
    this.notify();
  }

  // -- the tick --------------------------------------------------------------------------------------------------

  /** Brings the markers up to date: the time left, paused, ending; a Bypass that ended says why. */
  tick(): void {
    if (this.#disposed) return;
    const grants = this.#agent.grants;
    const work = grants.available ? grants.live.find(g => g.kind === "work") : undefined;
    this.#work = work;
    if (!work) {
      this.#markerText = "";
      this.#ending = false;
    } else {
      const left = grants.remaining(work);
      this.#markerText = work.status === "paused" ? this.#strings.markerPaused : this.#strings.markerWorking(period(this.#strings, left));
      this.#ending = work.status === "active" && left <= ENDING_SOON;
    }
    this.#tickBypass();
    this.notify();
    for (const listener of [...this.#tickedListeners]) listener();
  }

  /** @internal The language changed: the cards and the markers read the new one. */
  retext(): void {
    for (const card of this.#cards) card.retext();
    this.bypassCard?.retext();
    this.tick();
  }

  /**
   * @internal Asks for Bypass in `session`: the confirmation shows in this chat; after the person's click the card waits
   * for the server and says when it gives no acknowledgement (L-59). `on` once the server confirmed it; false when
   * declined, not offered, or not confirmed. An error with no card to say it on is returned as `unsaid`.
   */
  async startBypass(session: ChatSession, signal: AbortSignal): Promise<{ on: boolean; unsaid?: unknown }> {
    this.#bypassCard = undefined;
    this.#setEnded(false, null);
    this.notify();
    try {
      const grant = await session.startBypass(undefined, signal);
      if (!grant) {
        this.bypassCard?.withdrawn();
        return { on: false };
      }
      this.bypassCard?.confirmed();
      this.tick();
      return { on: true };
    } catch (error) {
      if (signal.aborted) {
        this.bypassCard?.withdrawn();
        return { on: false };
      }
      const card = this.bypassCard;
      if (card && (card.waiting || card.state === "not_confirmed")) {
        card.notConfirmed(error);
        return { on: false };
      }
      return { on: false, unsaid: error };
    }
  }

  /** @internal Another chat or a new one: a confirmation not yet answered goes. */
  leave(): void {
    this.#bypassCard?.withdrawn();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
  }

  // -- private ---------------------------------------------------------------------------------------------------

  #say(problem: string): void {
    if (this.#problem === problem) return;
    this.#problem = problem;
    this.notify();
  }

  #setEnded(ended: boolean, why: string | null): void {
    if (this.#bypassEnded === ended && this.#bypassEndedWhy === why) return;
    this.#bypassEnded = ended;
    this.#bypassEndedWhy = why;
    this.notify();
  }

  #tickBypass(): void {
    const session = this.#host.session();
    const bypass = session?.bypass;
    if (session?.id !== this.#bypassChat) {
      // Another chat: what the last one showed is not this one's.
      this.#bypass = undefined;
      this.#bypassChat = session?.id;
      this.#setEnded(false, null);
      if (this.#bypassCard && this.#bypassCard.conversationId !== this.#bypassChat) this.#bypassCard = undefined;
    }
    // Paused by the app's end is not ended: the next start resumes it, so the chat neither says it ended nor leaves Bypass,
    // which would end the paused grant too.
    const before = this.#bypass;
    const ended = !bypass && before && !this.#agent.grants.live.some(g => g.id === before.id && g.status === "paused") ? before : undefined;
    const started = bypass !== undefined && this.#bypass === undefined;
    this.#bypass = bypass;
    this.#bypassText = bypass ? this.#strings.bypassMarker(period(this.#strings, this.#agent.grants.remaining(bypass))) : "";
    this.#bypassRecorded = bypass ? this.#strings.bypassRecorded[evidenceLevel(bypass.evidenceLevel)] : "";
    if (ended) void this.#sayWhyEnded(ended.id); // the server's end, a Stop, a Revoke in Settings: the marker goes and the chat says why
    else if (started) this.#setEnded(false, null);
  }

  async #sayWhyEnded(grantId: string): Promise<void> {
    const chat = this.#bypassChat;
    this.#setEnded(true, null);
    for (const listener of [...this.#bypassEndedListeners]) listener();
    let why: string | null = null;
    try {
      why = await this.#agent.grants.whyEnded(grantId);
    } catch {
      why = null;
    }
    if (!this.#disposed && this.#bypassChat === chat && this.#bypassEnded && this.#bypass === undefined) this.#setEnded(true, why);
  }

  /** The tick: the markers; while a Bypass runs, the copy from the server now and then, so its end shows. */
  #onTimer(): void {
    this.tick();
    if (this.hasBypass && Date.now() - this.#lastRefresh >= GrantsViewModel.BYPASS_REFRESH) {
      this.#lastRefresh = Date.now();
      void this.#agent.grants.refresh().catch(() => undefined); // offline: the marker counts on by the server's clock
    }
  }

  #onGrantRequested(pending: PendingGrant): void {
    const session = this.#host.session();
    if (pending.offer.bypass) {
      // Only the chat of its conversation draws the confirmation; it says no more than the offer (L-58).
      if (pending.offer.conversationId !== undefined && pending.offer.conversationId !== session?.id) return;
      pending.claim();
      this.#bypassCard = new BypassPart(this.#context, pending, link => this.#broker.openBrowser(link));
      this.notify();
      return;
    }
    // A card offered for a conversation shows in the chat of that conversation only (sdk/46 C3): chats sharing one broker do
    // not show each other's cards. One offered before its conversation existed has none and shows in every chat, and so does
    // any card in a chat that has no conversation open yet.
    if (pending.offer.conversationId !== undefined && session && pending.offer.conversationId !== session.id) return;
    this.#cards = [...this.#cards, new GrantPart(this.#context, pending)];
    this.notify();
  }
}

// -- the device-wide marker ------------------------------------------------------------------------------------

/** One running grant as the device-wide marker lists it. */
export interface GrantMarkerEntry {
  grantId: string;
  kind: string;
  conversationId: string | null;
  /** The line: kind, chat, time left or paused ("Bypass · Order form · 12 min left"). */
  text: string;
  /** The time left by the server's clock ("12 min"). */
  left: string;
  isPaused: boolean;
  /** The grant is near its end and can be extended: "another 30 min" is offered. */
  isEnding: boolean;
}

/** What a grant that ended leaves: one summary per grant, saying how long it ran and why it ended. */
export class GrantSummary {
  constructor(
    readonly grantId: string,
    readonly kind: string,
    readonly reason: GrantEnded["reason"],
    /** "Worked alongside you for 23 min", "Bypass ran for 23 min". */
    readonly title: string,
    /** Where it worked, how many calls ran without asking, and why it ended, one per line. */
    readonly detail: string,
  ) {}
}

/** The device-wide marker's host hooks. */
export interface GrantMarkerOptions {
  /** The title of the chat of a conversation id; undefined or empty: "A chat". */
  chatTitle?: (conversationId: string) => string | undefined;
  /** Stops the running turn of a conversation (by id) when Stop ends its grant; none: only the grants. */
  stopTurn?: (conversationId: string) => void;
  /** The label of a place (type, identifier) for a summary; none: a file's name, else as given. */
  placeLabel?: (type: string, identifier: string) => string | undefined;
}

/**
 * The marker for every grant this device holds for the agent, across chats (sdk/46 G2): a stretch of work, Bypass, and
 * what the app adds. It shows the time left by the server's clock, Stop (every grant of the device, and the running turns
 * of their conversations), near the end "another 30 min" once, and one summary per grant when it ends, saying why. The
 * rules -- pausing at the app's end and at the lock, ending after 30 minutes -- are `GrantLifecycle`'s; this shows them.
 * A chat's own marker (`GrantsViewModel`) stays for the chat; this is the one a host shows outside it: a title bar's
 * chip, an avatar's badge, a tray's menu. No text is its own. .NET: `Fadenstack.UI.ViewModels.GrantMarkerViewModel`.
 */
export class GrantMarkerViewModel extends Observable {
  readonly #lifecycle: GrantLifecycle;
  readonly #strings: () => UiStrings;
  readonly #options: GrantMarkerOptions;
  readonly #unsubscribe: (() => void)[] = [];
  #deferred: GrantSummary[] = [];
  #summaries: readonly GrantSummary[] = [];
  #entries: readonly GrantMarkerEntry[] = [];
  #markerText = "";
  #badgeText = "";
  #problem = "";
  #isOn = false;
  #isPaused = false;
  #isEnding = false;
  #disposed = false;

  /**
   * @param lifecycle The rules (`GrantLifecycle` over the agent's grants).
   * @param strings The texts, in the UI language (read on each change; call `retext()` when the language changed).
   */
  constructor(lifecycle: GrantLifecycle, strings: () => UiStrings, options: GrantMarkerOptions = {}) {
    super();
    this.#lifecycle = lifecycle;
    this.#strings = strings;
    this.#options = options;
    this.#unsubscribe.push(
      lifecycle.onChanged(() => this.#refresh()),
      lifecycle.onEnded(event => this.#onEnded(event)),
      lifecycle.onEndingSoon(() => this.#refresh()),
    );
    this.#refresh();
  }

  /** A grant of this device runs (or waits, paused): the marker shows. */
  get isOn(): boolean { return this.#isOn; }
  /** The grant ending first is paused. */
  get isPaused(): boolean { return this.#isPaused; }
  /** A grant is near its end and can be extended: "Another 30 min" is offered. */
  get isEnding(): boolean { return this.#isEnding; }

  /**
   * "Working alongside you · 23 min left", "Bypass on · 12 min left", or with several grants "2 grants running · first ends
   * in 12 min"; empty while none runs.
   */
  get markerText(): string { return this.#markerText; }

  /** The time left of the grant ending first ("23 min"), or "Paused"; empty while none runs: an avatar's badge. */
  get badgeText(): string { return this.#badgeText; }

  /** Every running grant, the one ending first first: a menu's lines. */
  get entries(): readonly GrantMarkerEntry[] { return this.#entries; }

  /** What went wrong that the person should know, or that a paused grant waits for the server; empty when nothing. */
  get message(): string {
    return this.#problem || (this.#lifecycle.waiting > 0 ? this.#strings().grantsWaiting : "");
  }

  get hasMessage(): boolean { return this.message.length > 0; }

  dismissMessage(): void {
    this.#problem = "";
    this.notify();
  }

  /** One summary per grant that ended, newest last; the host shows them (a notice) and the person dismisses each. */
  get summaries(): readonly GrantSummary[] { return this.#summaries; }

  dismiss(summary: GrantSummary): void {
    this.#summaries = this.#summaries.filter(s => s !== summary);
    this.notify();
  }

  /** "Stop": a chip's button and a menu item. */
  get stopText(): string { return this.#strings().markerStop; }

  /** "Close": the button that takes a summary away. */
  get dismissText(): string { return this.#strings().close; }

  /** "Another 30 min": offered near the end. */
  get keepGoingText(): string {
    return this.#strings().markerKeepGoing(period(this.#strings(), GrantLifecycle.KEEP_GOING_BY));
  }

  /** The UI language changed: the marker, the lines and the texts read the new language. */
  retext(): void {
    this.#refresh();
  }

  /** Stops everything: the running turns of the grants' conversations, then every grant of this device. Never more time. */
  async stop(): Promise<void> {
    for (const grant of this.#lifecycle.running) if (grant.conversationId) this.#options.stopTurn?.(grant.conversationId);
    this.#problem = "";
    const result = await this.#lifecycle.stop();
    if (!result.complete) this.#problem = this.#strings().grantsStopFailed;
    this.#refresh();
  }

  /**
   * Adds another 30 minutes to the grant `grantId`, or to each that is near its end; the server cuts it at the longest
   * grant (the message says so). Bypass is never offered it.
   */
  async keepGoing(grantId?: string): Promise<void> {
    const targets = this.#lifecycle.running.filter(g => grantId === undefined ? this.#isNearEnd(g) : g.id === grantId).map(g => g.id);
    for (const id of targets) {
      try {
        await this.#lifecycle.keepGoing(id, `${this.#markerText}\n${this.keepGoingText}`);
        this.#problem = "";
      } catch (error) {
        this.#problem = codeOf(error) === AT_LONGEST_CODE ? this.#strings().grantsAtLongest : this.#strings().grantsExtendFailed;
      }
    }
    this.#refresh();
  }

  dispose(): void {
    this.#disposed = true;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
  }

  #isNearEnd(grant: AgentGrant): boolean {
    if (grant.kind === "bypass" || grant.status !== "active") return false;
    const left = this.#lifecycle.grants.remaining(grant);
    return left > 0 && left <= GrantLifecycle.ENDING_SOON_BEFORE;
  }

  #refresh(): void {
    if (this.#disposed) return;
    const s = this.#strings();
    const running = this.#lifecycle.running;
    const first = running[0];
    if (!first) {
      this.#markerText = this.#badgeText = "";
      this.#isPaused = this.#isEnding = this.#isOn = false;
      this.#entries = [];
    } else {
      const left = period(s, this.#lifecycle.grants.remaining(first));
      this.#isPaused = first.status === "paused";
      this.#markerText = running.length > 1 ? s.grantsMarkerMany(running.length, left)
        : first.kind === "bypass" ? (this.#isPaused ? s.grantsBypassPaused : s.bypassMarker(left))
        : this.#isPaused ? s.markerPaused : s.markerWorking(left);
      this.#badgeText = this.#isPaused ? s.grantsBadgePaused : left;
      this.#entries = running.map(g => this.#entry(g, s));
      this.#isEnding = running.some(g => this.#isNearEnd(g));
      this.#isOn = true;
    }
    if (!this.#lifecycle.isLocked && this.#deferred.length > 0) {
      // The person is back: the summaries that waited for them show.
      this.#summaries = [...this.#summaries, ...this.#deferred];
      this.#deferred = [];
    }
    this.notify();
  }

  #entry(grant: AgentGrant, s: UiStrings): GrantMarkerEntry {
    const left = period(s, this.#lifecycle.grants.remaining(grant));
    const paused = grant.status === "paused";
    const title = grant.conversationId ? this.#options.chatTitle?.(grant.conversationId) : undefined;
    const kind = grant.kind === "bypass" ? s.modes.bypass.label : s.grantsKindWork;
    const text = [kind, title || s.grantsChatUnknown, paused ? s.grantsPaused : s.grantsLeft(left)].join(" · ");
    return { grantId: grant.id, kind: grant.kind, conversationId: grant.conversationId, text, left, isPaused: paused, isEnding: this.#isNearEnd(grant) };
  }

  #onEnded(event: GrantEnded): void {
    if (this.#disposed) return;
    const s = this.#strings();
    const grant = event.grant;
    const places = [...new Set((grant.scope.targets ?? []).flatMap(t => t.identifiers.map(i => this.#options.placeLabel?.(t.type, i) ?? shortPlace(i))))];
    const lines: string[] = [];
    if (places.length > 0) lines.push(s.grantsSummaryPlaces(places.join(" · ")));
    if (grant.kind !== "bypass" || event.callsUsed > 0) lines.push(s.grantsSummaryCalls(event.callsUsed));
    lines.push(s.grantsEnded[event.reason]);
    const ran = period(s, event.ran);
    const summary = new GrantSummary(grant.id, grant.kind, event.reason,
      grant.kind === "bypass" ? s.grantsSummaryBypass(ran) : s.grantsSummaryWork(ran), lines.join("\n"));
    // Ended after the lock: the summary waits until the person is back.
    if (event.reason === "locked" && this.#lifecycle.isLocked) this.#deferred.push(summary);
    else this.#summaries = [...this.#summaries, summary];
    this.#refresh();
  }
}
