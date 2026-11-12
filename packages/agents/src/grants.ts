import {
  FadenstackApiError,
  FadenstackAuthenticationError,
  FadenstackError,
  SDK_VERSION,
  bytesSha256,
  toAgentGrants,
  type AgentGrant,
  type ApprovalSettings,
  type GrantReport,
  type GrantRequest,
  type GrantTarget,
  type ToolClass,
} from "@fadenstack/client";
import type { FadenstackAgent } from "./agent.js";
import { isLocalPath, lies, named, namesPath } from "./grantPaths.js";
import { BypassSignInError } from "./stepUp.js";

export interface GrantPlace { type: GrantTarget["type"]; identifier: string; label: string }
export const GrantPlace = {
  document: (identifier: string, label = identifier.split(/[/\\]/).pop() || identifier): GrantPlace => ({ type: "document", identifier, label }),
  folder: (identifier: string, label = identifier): GrantPlace => ({ type: "folder", identifier, label }),
  site: (identifier: string, label = identifier): GrantPlace => ({ type: "site", identifier, label }),
  app: (identifier: string, label: string): GrantPlace => ({ type: "app", identifier, label }),
  desk: (identifier: string, label: string): GrantPlace => ({ type: "desk", identifier, label }),
};
const sameTarget = (a: GrantPlace, b: GrantPlace) => a.type === b.type && a.identifier === b.identifier && a.label === b.label;

/** One target per kind of place, each place once, as .NET sends them. */
const targetsOf = (places: readonly GrantPlace[]): GrantTarget[] => {
  const byType = new Map<GrantTarget["type"], string[]>();
  for (const place of places) {
    const identifiers = byType.get(place.type) ?? [];
    if (!identifiers.includes(place.identifier)) identifiers.push(place.identifier);
    byType.set(place.type, identifiers);
  }
  return [...byType].map(([type, identifiers]) => ({ type, identifiers }));
};
const minutesOf = (duration: number): number => {
  if (!Number.isFinite(duration)) throw new TypeError("A duration must be finite milliseconds.");
  return Math.max(1, Math.ceil(duration / 60_000));
};
/**
 * Resolve using native authority; null means no certified work-grant coverage. Never follow arbitrary URLs here. For a place
 * that names a path on the device (a document, a folder, an app) the resolver must give the canonical path as the
 * operating system reports it, every link, junction and mount point on the way resolved, a file that does not exist yet
 * below the real path of the part that does; the SDK then asks whether the real place lies in a real target
 * (`outside_grant` when it does not).
 */
export type GrantPlaceResolver = (place: Readonly<GrantPlace>, signal: AbortSignal) => Promise<GrantPlace | null>;
export interface GrantCall {
  callId: string;
  conversationId: string;
  turnId: string;
  toolName: string;
  toolClass: ToolClass;
  arguments: Readonly<Record<string, unknown>>;
  requiredByRule: boolean;
  /** The turn runs in Bypass: only then may the conversation's Bypass grant cover the call. */
  inBypass?: boolean;
  /** The call is a tool the gateway holds for the user (`faden.approval_required` with an approvalId): no Bypass covers it. */
  gateway?: boolean;
}

/** How a call stands against a grant: whether it holds, and where a link led the place out of the grant, if one did. */
export interface GrantVerdict { covered: boolean; leadsOutside?: string }

function pointer(value: unknown, path: string): unknown {
  for (const part of path.split("/").slice(1)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The longest reason the server keeps. */
export const REASON_LENGTH = 500;

/** `text` cut to `REASON_LENGTH` at a character's end: never between the two halves of a surrogate pair. */
export function cutReason(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= REASON_LENGTH) return text;
  const high = text.charCodeAt(REASON_LENGTH - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? REASON_LENGTH - 1 : REASON_LENGTH);
}

/** The server's word that the grant needs a fresh sign-in (RFC 9470's challenge, sdk/41). */
export const STEP_UP_REQUIRED = "bypass_step_up_required";

/**
 * The grant card (desktop 37 §5.3, 38 §7): the app asks the person to let the agent work alongside them -- read and write in
 * these places, for a while -- or to extend a running grant, showing only the difference; or, with `bypass`, to switch
 * approvals off in this conversation for a while. The card is drawn by the app from the places and the classes, never from
 * the model's wording. Durations are milliseconds.
 */
export interface GrantOffer {
  /** Where the agent would work; the person may remove places before allowing. */
  places: readonly GrantPlace[];
  /** What it may do there without asking: `read`, `write` (the agent's grant classes). */
  classes: readonly string[];
  /** The durations to pick from, within the agent's longest grant. */
  durations: readonly number[];
  /** What the card starts at (30 min, or less when the agent's longest is shorter). */
  preselected: number;
  /** The app's reason, if it gives one (its own text, never the model's). */
  reason?: string;
  /** The running grant this card extends; absent for a new grant. */
  extending?: AgentGrant;
  /**
   * A Bypass card (sdk/09 L-58): it says what will no longer be asked -- destructive and unclassified tools, in this
   * conversation -- what still asks (an admin's rules, tools that ask every time), what the server records of every call
   * (`evidence`), and for how long, with no extension. No places, no classes. A card that cannot say this answers
   * `GrantAnswer.notNow`.
   */
  bypass?: boolean;
  /** The conversation the card is for, when it has one. */
  conversationId?: string;
  /** For a Bypass card: what the server records of each call under it (`decisions`, `calls` or `results`). */
  evidence?: string;
}

/** What the person answered on the grant card. */
export interface GrantAnswer {
  allowed: boolean;
  /** The places the person kept (all of the offer's, unless they removed some). */
  places: readonly GrantPlace[];
  /** The time picked, in milliseconds: the grant's length, or for an extension how much longer. */
  duration: number;
  /** The card's text as the person saw it; its SHA-256 goes to the server as evidence. */
  shownText?: string;
  /** For a Bypass card: the person's own words on why, if they gave any (at most `REASON_LENGTH` characters). */
  reason?: string;
}
export const GrantAnswer = {
  /** The answer of a card that was declined, or that cannot say what it must. */
  notNow: Object.freeze({ allowed: false, places: Object.freeze([]), duration: 0 }) as GrantAnswer,
};

/**
 * Draws the grant card and returns the person's answer. A UI's approval handler that also has `requestGrant` is used for
 * it; without one, no grant is offered.
 */
export interface GrantHandler {
  requestGrant(offer: GrantOffer, signal: AbortSignal): Promise<GrantAnswer>;
}

/** Whether `value` has the shape of a grant handler (an approval handler may be one too). */
export function isGrantHandler(value: unknown): value is GrantHandler {
  return value !== null && typeof value === "object" && typeof (value as { requestGrant?: unknown }).requestGrant === "function";
}

/** Server-held grants. Cached timers are for display; coverage always requires a matching server event and fresh read. */
export class AgentGrants {
  /** Durations are milliseconds, the TypeScript equivalent of .NET TimeSpan. Wire values remain minutes. */
  static readonly durations: readonly number[] = Object.freeze([15, 30, 60, 120].map(minutes => minutes * 60_000));
  static readonly preselected = 30 * 60_000;
  /** How long a Bypass paused at the app's end may wait for the next start to resume it (D5, as a work grant). */
  static readonly resumeWithin = 30 * 60_000;
  readonly #agent: FadenstackAgent;
  readonly #resolve: GrantPlaceResolver | undefined;
  readonly #known = new Map<string, AgentGrant>();
  // Every grant the copy saw, as it last saw it, kept when a new list replaces the copy: why one ended (`whyEnded`).
  readonly #seen = new Map<string, AgentGrant>();
  readonly #used = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #offsetMs = 0;

  constructor(agent: FadenstackAgent, resolver?: GrantPlaceResolver) { this.#agent = agent; this.#resolve = resolver; }

  /** The client this SDK names itself as in a grant's record (L-59). */
  get clientVersion(): string { return `@fadenstack/agents/${SDK_VERSION}`; }

  get available(): boolean {
    return this.settings !== undefined && !!this.#agent.profile.principal?.deviceId;
  }

  /**
   * What the agent allows (the profile's `approvals`); undefined unless the server holds grants (`approval_scopes.grant`)
   * and says what the agent allows. The profile's `approvals` alone is not read as grants.
   */
  get settings(): ApprovalSettings | undefined {
    if (!this.#agent.isStarted) return undefined;
    const profile = this.#agent.profile;
    return profile.features.includes("approval_scopes.grant") ? profile.approvals : undefined;
  }

  /** Whether the agent offers the standing approval `kind`: `time` or `grant`. */
  offers(kind: "time" | "grant"): boolean {
    const settings = this.settings;
    return this.available && !!settings && settings.longestGrantMinutes > 0
      && (settings.standing === null || settings.standing.includes(kind));
  }

  /** The durations a card may offer for this agent: those within its longest grant. */
  get choices(): readonly number[] { return AgentGrants.durations.filter(duration => duration <= (this.settings?.longestGrantMinutes ?? 0) * 60_000); }

  /** The durations a Bypass card may offer: those within its longest; none where the server does not offer Bypass here. */
  get bypassChoices(): readonly number[] {
    const bypass = this.available ? this.settings?.bypass : undefined;
    return bypass?.allowed ? AgentGrants.durations.filter(duration => duration <= bypass.longestMinutes * 60_000) : [];
  }

  /** Whether the server offers Bypass for this agent now (the profile says so, and this device can hold a grant). */
  get bypassOffered(): boolean { return this.available && this.settings?.bypass?.allowed === true; }

  /** The server's clock now, from the offset its last answer showed. */
  get serverNow(): Date { return new Date(this.#agent.clock() + this.#offsetMs); }
  remaining(grant: AgentGrant): number { return Math.max(0, Date.parse(grant.expiresAt) - this.serverNow.getTime()); }

  /** The grants that may still cover a call, the one ending first first. */
  get live(): readonly AgentGrant[] {
    const now = this.#agent.clock() + this.#offsetMs;
    return [...this.#known.values()].filter(g => ["active", "paused"].includes(g.status) && Date.parse(g.expiresAt) > now
      && (g.maxCalls === null || g.callsUsed < g.maxCalls)).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)).map(g => structuredClone(g));
  }

  /** The copy's grant `id`, live or not; undefined when it does not know it. */
  find(id: string): AgentGrant | undefined {
    const grant = this.#known.get(id);
    return grant ? structuredClone(grant) : undefined;
  }

  /** Whether the copy knows `id` at all. */
  knows(id: string): boolean { return this.#known.has(id); }

  /** The live, active Bypass grant of the conversation `conversationId`; undefined when it has none. */
  bypassFor(conversationId: string): AgentGrant | undefined {
    return this.live.find(g => g.kind === "bypass" && g.status === "active" && g.conversationId === conversationId);
  }

  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #notify(): void { for (const listener of this.#listeners) listener(); }

  // Whether the grant is this agent version's on this device.
  #isOwned(grant: AgentGrant): boolean {
    const profile = this.#agent.profile;
    return grant.agentId === profile.id && grant.deviceId === profile.principal?.deviceId && grant.agentVersion === profile.version;
  }

  #owned(grant: AgentGrant): void {
    if (!this.#isOwned(grant)) throw new Error("The grant belongs to another agent version or device.");
  }

  // Whether the server's grant is the one asked for: of this kind, running, with time left but no more than asked, for the
  // conversation asked, and the agent's own. The caller checks the scope.
  #answers(grant: AgentGrant, kind: AgentGrant["kind"], minutes: number, conversationId: string | undefined): boolean {
    return grant.kind === kind && grant.status === "active" && grant.remainingS > 0 && grant.remainingS <= minutes * 60
      && (conversationId === undefined || grant.conversationId === conversationId) && this.#isOwned(grant);
  }

  #keep(grant: AgentGrant): AgentGrant {
    this.#owned(grant);
    this.#offsetMs = Date.parse(grant.serverNow) - this.#agent.clock();
    this.#known.set(grant.id, structuredClone(grant));
    this.#seen.set(grant.id, structuredClone(grant));
    this.#notify();
    return structuredClone(grant);
  }

  #replace(grants: readonly AgentGrant[], serverNow: string | undefined): void {
    this.#known.clear();
    for (const grant of grants) {
      this.#known.set(grant.id, structuredClone(grant));
      this.#seen.set(grant.id, structuredClone(grant));
    }
    if (serverNow !== undefined) this.#offsetMs = Date.parse(serverNow) - this.#agent.clock();
    this.#notify();
  }

  /**
   * Replace, never union an old authority snapshot with a new one. A malformed snapshot, or a grant of another agent
   * version or device, clears cached authority; a single grant this SDK cannot read is left out (`toAgentGrants`).
   */
  snapshot(value: unknown): void {
    try {
      const event = value as { serverNow?: unknown; grants?: unknown };
      if (typeof event?.serverNow !== "string" || !Array.isArray(event.grants)) throw new Error("Invalid grant snapshot.");
      const grants = toAgentGrants(event.grants, event.serverNow);
      for (const grant of grants) this.#owned(grant);
      this.#replace(grants, event.serverNow);
    } catch { this.#replace([], undefined); }
  }

  /** Reads the device's grants from the server again; without grants on the server, clears the copy. */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.available) { this.#replace([], undefined); return; }
    try {
      const list = await this.#agent.client.agent!.listGrants(signal);
      for (const grant of list.data) this.#owned(grant);
      this.#replace(list.data, list.serverNow);
    } catch (error) { this.#replace([], undefined); throw error; }
  }

  /** Call only after a human confirms the actual grant card. A refusal never creates a local replacement grant. */
  async grantForTime(tool: string, duration: number, conversationId?: string, shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
    const minutes = minutesOf(duration);
    const declared = this.#agent.find(tool)?.toolClass;
    if (!this.offers("time") || declared !== undefined && !["read", "write"].includes(declared)
      || this.#agent.profile.hostToolContract.find(t => t.name === tool)?.approval === "always")
      throw new Error("A time grant is not offered for this call.");
    const shownTextSha256 = shownText === undefined ? undefined : await bytesSha256(new TextEncoder().encode(shownText));
    const grant = await this.#agent.client.agent!.createGrant({ kind: "time", tools: [tool], minutes,
      ...(conversationId ? { conversation: true } : {}), ...(shownTextSha256 ? { shownTextSha256 } : {}) }, { conversationId, signal });
    if (!this.#answers(grant, "time", minutes, conversationId) || grant.scope.tools?.length !== 1 || grant.scope.tools[0] !== tool)
      throw new Error("The returned grant exceeds or differs from the confirmed request. Inspect active grants.");
    return this.#keep(grant);
  }

  async grantWork(places: readonly GrantPlace[], duration: number, conversationId: string, shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
    const minutes = minutesOf(duration);
    const targets = targetsOf(places);
    if (!this.offers("grant") || !this.#resolve || !targets.length || !this.#agent.profile.approvals!.grantClasses.length
      || !places.every(place => !!place.identifier))
      throw new Error("A certified work grant is not offered.");
    for (const target of targets) {
      if (!target.identifiers.length || target.actions?.length === 0) throw new Error("A grant place must have permitted actions.");
      for (const identifier of target.identifiers) {
        const resolved = await this.#resolve({ type: target.type, identifier, label: identifier }, signal ?? new AbortController().signal);
        if (!resolved || resolved.type !== target.type || resolved.identifier !== identifier)
          throw new Error("The proposed grant place is not its authorized canonical identity.");
      }
    }
    const classes = [...this.#agent.profile.approvals!.grantClasses];
    const grant = await this.#agent.client.agent!.createGrant({ kind: "work", targets: structuredClone([...targets]), minutes,
      classes, ...(shownText === undefined ? {} : { shownTextSha256: await bytesSha256(new TextEncoder().encode(shownText)) }) }, { conversationId, signal });
    if (!this.#answers(grant, "work", minutes, conversationId)
      || !grant.scope.classes?.length || !grant.scope.targets?.length || grant.scope.classes.some(c => !classes.includes(c as "read" | "write"))
      || grant.scope.targets.some(target => target.identifiers.some(identifier =>
        (target.actions ?? grant.scope.classes!).some(action => !targets.some(proposed => proposed.type === target.type
          && (!proposed.actions || proposed.actions.includes(action as "read" | "write"))
          && proposed.identifiers.some(asked => named(target.type, asked, identifier)))))))
      throw new Error("The returned work grant exceeds the confirmed places or actions. Inspect active grants.");
    return this.#keep(grant);
  }

  /**
   * Switches approvals off in the conversation `conversationId` for `duration` (sdk/09 §3.12): what its mode would ask
   * about runs, destructive and unclassified calls too -- never an admin's rule or a tool that asks every time. The
   * server's answer is the record (L-59): Bypass holds only once it answered, and a refusal is thrown (403
   * `bypass_not_allowed`). `reason` is the person's own words, if any.
   *
   * The server makes the grant only with the proof of a fresh sign-in (sdk/41; ASVS 5.0 7.5.3): the one this device holds
   * while it lasts, else a second sign-in in the browser through the app's step-up handler, which the person approves
   * there. Without a handler, or when the sign-in does not happen, no grant: `BypassSignInError`. A held proof the server no
   * longer takes is dropped and the sign-in asked once more.
   */
  async grantBypass(duration: number, conversationId: string, reason?: string, shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
    const handler = this.#agent.stepUpHandler;
    if (!handler) throw new BypassSignInError("failed", "The app opens no second sign-in, which Bypass needs.");
    const minutes = minutesOf(duration);
    const cut = cutReason(reason);
    const request: GrantRequest = { kind: "bypass", minutes, clientVersion: this.clientVersion,
      ...(shownText === undefined ? {} : { shownTextSha256: await bytesSha256(new TextEncoder().encode(shownText)) }),
      ...(cut === undefined ? {} : { reason: cut }) };
    const longest = this.settings?.bypass?.longestMinutes;
    for (let attempt = 0; ; attempt++) {
      const proof = await this.#agent.stepUps.obtain(handler, conversationId, longest, signal ?? new AbortController().signal);
      try {
        const grant = await this.#agent.client.agent!.createGrant(request, { conversationId, stepUpProof: proof, signal });
        if (!this.#answers(grant, "bypass", minutes, conversationId))
          throw new Error("The returned Bypass grant exceeds or differs from the confirmed request. Inspect active grants.");
        return this.#keep(grant);
      } catch (error) {
        // Too old by the server's clock, or not this device's: sign in again, once.
        if (error instanceof FadenstackAuthenticationError && error.code === STEP_UP_REQUIRED && attempt === 0) this.#agent.stepUps.forget();
        else throw error;
      }
    }
  }

  /** The calls the device ran under a Bypass grant in the turn that just ended, for the gateway to compare (L-61). */
  report(grantId: string, calls: readonly string[], signal?: AbortSignal): Promise<GrantReport> {
    return this.#agent.client.agent!.reportGrant(grantId, calls, signal);
  }

  /**
   * Why a grant this copy held has ended, for the app to say (sdk/09 L-59, L-63): `person` (ended here, in Settings or on
   * another sign-in of theirs), `admin`, `kill_switch` (Bypass turned off for the organisation), `limit` (a narrower limit
   * or list of the organisation's), `agent`, `expired` or `spent`; null while it runs, or when not even the server can say
   * (an older server, offline). What the copy recorded comes first -- a Stop here answers at once -- then its time by the
   * server's clock, then the server.
   */
  async whyEnded(grantId: string, signal?: AbortSignal): Promise<string | null> {
    const known = this.#ended(this.#seen.get(grantId));
    if (known) return known;
    try {
      const found = await this.#agent.client.agent!.getGrant(grantId, signal);
      this.#seen.set(found.id, structuredClone(found));
      return this.#ended(found);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof FadenstackError) return null; // the server cannot say: the app says the server ended it
      throw error;
    }
  }

  // Why a grant as last seen has ended; null while it runs.
  #ended(grant: AgentGrant | undefined): string | null {
    if (!grant) return null;
    if (grant.revokedBy) return grant.revokedBy;
    if (grant.status === "expired") return "expired";
    if (grant.status === "spent" || grant.maxCalls !== null && grant.callsUsed >= grant.maxCalls) return "spent";
    if (Date.parse(grant.expiresAt) <= this.serverNow.getTime()) return "expired";
    return null;
  }

  async pause(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.pauseGrant(id, signal)); }
  async resume(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.resumeGrant(id, signal)); }
  async revoke(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.revokeGrant(id, signal)); }

  /** Ends every grant this device holds for the agent: the marker's Stop. */
  async revokeAll(signal?: AbortSignal): Promise<void> {
    for (const grant of this.live) await this.revoke(grant.id, signal);
  }

  /**
   * The app's end (owner, 2026-11-09): pauses this device's running Bypass grants for the agent, as a work grant pauses.
   * The clock runs on; the next start resumes them (`resumeBypass`). Offline, they run on at the server until their
   * time. Returns those paused.
   */
  async pauseBypass(signal?: AbortSignal): Promise<AgentGrant[]> {
    const paused: AgentGrant[] = [];
    for (const grant of this.live.filter(g => g.kind === "bypass" && g.status === "active")) {
      await this.pause(grant.id, signal);
      paused.push(grant);
    }
    return paused;
  }

  /**
   * The next start: resumes each Bypass grant of this device paused less than `resumeWithin` ago by the server's clock --
   * no card, no second sign-in; the server checks that Bypass is still allowed -- and ends each paused longer. Returns
   * those that did not resume, with why (`whyEnded`'s words, or `paused_too_long`, `ended` when the server ended one after
   * the list was read and cannot say why, or `unavailable` when the server could not check: it stays paused).
   */
  async resumeBypass(signal?: AbortSignal): Promise<{ grant: AgentGrant; why: string }[]> {
    await this.refresh(signal);
    const ended: { grant: AgentGrant; why: string }[] = [];
    for (const grant of this.live.filter(g => g.kind === "bypass" && g.status === "paused")) {
      if (grant.pausedAt !== null && this.serverNow.getTime() - Date.parse(grant.pausedAt) >= AgentGrants.resumeWithin) {
        await this.revoke(grant.id, signal);
        ended.push({ grant, why: "paused_too_long" });
        continue;
      }
      try {
        await this.resume(grant.id, signal);
      } catch (error) {
        if (!(error instanceof FadenstackApiError)) throw error;
        if (error.status === 403 || error.status === 404) {
          // No longer allowed (403: the server ended it now), or ended since the list was read (404: the kill switch, an
          // administrator): the server says why.
          ended.push({ grant, why: await this.whyEnded(grant.id, signal) ?? (error.status === 403 ? "limit" : "ended") });
        } else if (error.status === 503) ended.push({ grant, why: "unavailable" });
        else throw error;
      }
    }
    return ended;
  }

  /**
   * The caller must show and confirm the added time/places; the server may narrow or refuse it. A Bypass grant is not
   * extended (L-58): the copy's own is refused here, unsent, and the server refuses one the copy does not know
   * (`bypass_not_extendable`).
   */
  async extend(id: string, more: number, places: readonly GrantPlace[] = [], shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
    if (this.#known.get(id)?.kind === "bypass") throw new Error("A Bypass grant is not extended: more time is a new Bypass, confirmed again.");
    const extension = { minutes: more > 0 ? minutesOf(more) : 0, targets: targetsOf(places),
      ...(shownText === undefined ? {} : { shownTextSha256: await bytesSha256(new TextEncoder().encode(shownText)) }) };
    const before = await this.#agent.client.agent!.getGrant(id, signal);
    this.#owned(before);
    if (before.kind === "bypass" || !this.offers(before.kind === "work" ? "grant" : "time")) throw new Error("This grant cannot be extended.");
    if (extension.targets?.length) {
      if (before.kind !== "work" || !this.#resolve) throw new Error("This grant cannot gain places.");
      for (const target of extension.targets) for (const identifier of target.identifiers) {
        const canonical = await this.#resolve({ type: target.type, identifier, label: identifier }, signal ?? new AbortController().signal);
        if (!canonical || canonical.type !== target.type || canonical.identifier !== identifier) throw new Error("The added place is not canonical.");
      }
    }
    return this.#keep(await this.#agent.client.agent!.extendGrant(id, extension, signal));
  }

  /** Internal: a grant_used event is mandatory. Every check rereads server state; no timer or cache authorizes. */
  async covers(id: string, call: GrantCall, signal: AbortSignal, dispatch = false): Promise<boolean> {
    return (await this.check(id, call, signal, dispatch)).covered;
  }

  /**
   * The second line (38 §6): whether the server's current grant `id` is active and unexpired for this call -- a grant for a
   * time for this very tool, a stretch of work for its class and the place its tool names, which must lie in one of the
   * grant's places where it really leads (`GrantPlaceResolver`; `leadsOutside` is the real place when a link took it out of
   * the grant). Never a destructive or unclassified call -- but for a Bypass grant, which covers every class, and only the
   * conversation's own, while the turn runs in Bypass, never a tool the gateway holds for the user.
   */
  async check(id: string, call: GrantCall, signal: AbortSignal, dispatch = false): Promise<GrantVerdict> {
    const no: GrantVerdict = { covered: false };
    if (!this.available || call.requiredByRule) return no;
    const entry = this.#agent.profile.hostToolContract.find(t => t.name === call.toolName);
    if (entry?.approval === "always") return no;
    const key = JSON.stringify([call.conversationId, call.turnId, call.callId]);
    if (dispatch ? this.#used.get(key) !== id : this.#used.has(key)) return no;
    const readOrWrite = ["read", "write"].includes(call.toolClass);
    try {
      const grant = this.#keep(await this.#agent.client.agent!.getGrant(id, signal));
      const bypass = grant.kind === "bypass";
      if (!bypass && (!readOrWrite || !this.offers(grant.kind === "time" ? "time" : "grant")
        || !this.#agent.profile.approvals!.grantClasses.includes(call.toolClass as "read" | "write"))) return no;
      // Spent may be the very call already charged by the server's grant_used event.
      if (!(bypass ? grant.status === "active" : ["active", "spent"].includes(grant.status))
        || Date.parse(grant.expiresAt) <= Date.parse(grant.serverNow) || grant.remainingS <= 0
        || grant.maxCalls !== null && grant.callsUsed > grant.maxCalls) return no;
      let holds = false;
      let leadsOutside: string | undefined;
      if (bypass) {
        holds = call.inBypass === true && call.gateway !== true && grant.conversationId === call.conversationId;
      } else {
        if (grant.callsUsed < 1 || grant.conversationId !== null && grant.conversationId !== call.conversationId) return no;
        holds = grant.kind === "time" && grant.scope.tools?.length === 1 && grant.scope.tools[0] === call.toolName;
        if (grant.kind === "work" && this.#resolve && entry?.targetType && entry.targetArgument && grant.scope.classes?.includes(call.toolClass)) {
          const identifier = pointer(call.arguments, entry.targetArgument);
          if (typeof identifier === "string" && identifier) {
            const place = await this.#resolve({ type: entry.targetType, identifier, label: identifier }, signal);
            if (place) ({ holds, leadsOutside } = await this.#inPlaces(grant, place, call.toolClass as "read" | "write", signal));
          }
        }
      }
      if (holds && !dispatch) {
        if (this.#used.size >= 1000) return no; // bounded session guard; never evict replay protection to permit a call
        this.#used.set(key, id);
      }
      return holds ? { covered: true } : { covered: false, ...(leadsOutside !== undefined ? { leadsOutside } : {}) };
    } catch (error) { if (signal.aborted) throw signal.reason ?? error; return no; }
  }

  // In one of the grant's places of its type whose actions hold the class, as the gateway checks it; a path on a device by
  // where it really leads, the place's and the targets' (ASVS 5.0 5.3.2: the gateway sees only the text).
  async #inPlaces(grant: AgentGrant, place: GrantPlace, toolClass: "read" | "write", signal: AbortSignal)
    : Promise<{ holds: boolean; leadsOutside?: string }> {
    const identifiers = (grant.scope.targets ?? [])
      .filter(t => t.type === place.type && (!t.actions || t.actions.includes(toolClass)))
      .flatMap(t => t.identifiers);
    if (!namesPath(place.type) || !isLocalPath(place.identifier)) {
      return { holds: identifiers.some(target => named(place.type, target, place.identifier)) };
    }
    for (const target of identifiers) {
      if (!isLocalPath(target)) continue;
      const real = await this.#resolve!({ type: place.type, identifier: target, label: target }, signal);
      if (real && real.type === place.type && lies(place.type, real.identifier, place.identifier)) return { holds: true };
    }
    return { holds: false, leadsOutside: place.identifier };
  }

  /** Whether `a` and `b` are the same place as a card showed it. */
  static samePlace(a: GrantPlace, b: GrantPlace): boolean { return sameTarget(a, b); }
}
