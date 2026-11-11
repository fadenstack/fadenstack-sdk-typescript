import { bytesSha256, toAgentGrants, type AgentGrant, type GrantTarget, type ToolClass, type ApprovalSettings } from "@fadenstack/client";
import type { FadenstackAgent } from "./agent.js";

export interface GrantPlace { type: GrantTarget["type"]; identifier: string; label: string }
export const GrantPlace = {
  document: (identifier: string, label = identifier.split(/[/\\]/).pop() || identifier): GrantPlace => ({ type: "document", identifier, label }),
  folder: (identifier: string, label = identifier): GrantPlace => ({ type: "folder", identifier, label }),
  site: (identifier: string, label = identifier): GrantPlace => ({ type: "site", identifier, label }),
  app: (identifier: string, label: string): GrantPlace => ({ type: "app", identifier, label }),
  desk: (identifier: string, label: string): GrantPlace => ({ type: "desk", identifier, label }),
};
const targetsOf = (places: readonly GrantPlace[]): GrantTarget[] => places.map(place => ({ type: place.type, identifiers: [place.identifier] }));
const minutesOf = (duration: number): number => {
  if (!Number.isFinite(duration)) throw new TypeError("A duration must be finite milliseconds.");
  return Math.max(1, Math.ceil(duration / 60_000));
};
/** Resolve using native authority; null means no certified work-grant coverage. Never follow arbitrary URLs here. */
export type GrantPlaceResolver = (place: Readonly<GrantPlace>, signal: AbortSignal) => Promise<GrantPlace | null>;
export interface GrantCall {
  callId: string;
  conversationId: string;
  turnId: string;
  toolName: string;
  toolClass: ToolClass;
  arguments: Readonly<Record<string, unknown>>;
  requiredByRule: boolean;
}

const pathKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function matches(place: GrantPlace, target: GrantTarget, toolClass: ToolClass): boolean {
  if (place.type !== target.type || target.actions && !target.actions.includes(toolClass as "read" | "write")) return false;
  return target.identifiers.some(value => {
    if (place.type === "site") {
      try { return new URL(place.identifier).origin === new URL(value).origin; } catch { return false; }
    }
    if (place.type === "folder") {
      if (place.identifier.replace(/\\/g, "/").split("/").includes("..")) return false;
      return (pathKey(place.identifier) + "/").startsWith(pathKey(value) + "/");
    }
    return pathKey(place.identifier) === pathKey(value);
  });
}
function pointer(value: unknown, path: string): unknown {
  for (const part of path.split("/").slice(1)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Server-held grants. Cached timers are for display; coverage always requires a matching server event and fresh read. */
export class AgentGrants {
  /** Durations are milliseconds, the TypeScript equivalent of .NET TimeSpan. Wire values remain minutes. */
  static readonly durations: readonly number[] = Object.freeze([15, 30, 60, 120].map(minutes => minutes * 60_000));
  static readonly preselected = 30 * 60_000;
  readonly #agent: FadenstackAgent;
  readonly #resolve: GrantPlaceResolver | undefined;
  readonly #known = new Map<string, AgentGrant>();
  readonly #used = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #offsetMs = 0;

  constructor(agent: FadenstackAgent, resolver?: GrantPlaceResolver) { this.#agent = agent; this.#resolve = resolver; }

  get available(): boolean {
    return this.#agent.isStarted && this.#agent.profile.features.includes("approval_scopes.grant")
      && !!this.#agent.profile.approvals && !!this.#agent.profile.principal?.deviceId;
  }

  offers(kind: "time" | "grant"): boolean {
    const settings = this.#agent.isStarted ? this.#agent.profile.approvals : undefined;
    return this.available && !!settings && settings.longestGrantMinutes > 0
      && (settings.standing === null || settings.standing.includes(kind));
  }

  get settings(): ApprovalSettings | undefined { return this.#agent.isStarted ? this.#agent.profile.approvals : undefined; }
  get choices(): readonly number[] { return AgentGrants.durations.filter(duration => duration <= (this.settings?.longestGrantMinutes ?? 0) * 60_000); }
  get serverNow(): Date { return new Date(Date.now() + this.#offsetMs); }
  remaining(grant: AgentGrant): number { return Math.max(0, Date.parse(grant.expiresAt) - this.serverNow.getTime()); }

  get live(): readonly AgentGrant[] {
    const now = Date.now() + this.#offsetMs;
    return [...this.#known.values()].filter(g => ["active", "paused"].includes(g.status) && Date.parse(g.expiresAt) > now
      && (g.maxCalls === null || g.callsUsed < g.maxCalls)).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)).map(g => structuredClone(g));
  }

  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #notify(): void { for (const listener of this.#listeners) listener(); }

  #owned(grant: AgentGrant): void {
    const profile = this.#agent.profile;
    if (grant.agentId !== profile.id || grant.deviceId !== profile.principal?.deviceId || grant.agentVersion !== profile.version)
      throw new Error("The grant belongs to another agent version or device.");
  }

  #keep(grant: AgentGrant): AgentGrant {
    this.#owned(grant);
    this.#offsetMs = Date.parse(grant.serverNow) - Date.now();
    this.#known.set(grant.id, structuredClone(grant));
    this.#notify();
    return structuredClone(grant);
  }

  /**
   * Replace, never union an old authority snapshot with a new one. A malformed snapshot, or a grant of another agent
   * version or device, clears cached authority; a single grant this SDK cannot read is left out (`toAgentGrants`).
   */
  snapshot(value: unknown): void {
    this.#known.clear();
    try {
      const event = value as { serverNow?: unknown; grants?: unknown };
      if (typeof event?.serverNow !== "string" || !Array.isArray(event.grants)) throw new Error("Invalid grant snapshot.");
      const grants = toAgentGrants(event.grants, event.serverNow);
      for (const grant of grants) this.#owned(grant);
      for (const grant of grants) this.#known.set(grant.id, structuredClone(grant));
      this.#offsetMs = Date.parse(event.serverNow) - Date.now();
    } catch { this.#known.clear(); }
    this.#notify();
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.available) { this.#known.clear(); this.#notify(); return; }
    try {
      const list = await this.#agent.client.agent!.listGrants(signal);
      for (const grant of list.data) this.#owned(grant);
      this.#known.clear();
      for (const grant of list.data) this.#known.set(grant.id, structuredClone(grant));
      this.#offsetMs = Date.parse(list.serverNow) - Date.now();
      this.#notify();
    } catch (error) { this.#known.clear(); this.#notify(); throw error; }
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
    if (grant.kind !== "time" || grant.status !== "active" || grant.remainingS <= 0
      || grant.scope.tools?.length !== 1 || grant.scope.tools[0] !== tool
      || grant.remainingS > minutes * 60 || conversationId && grant.conversationId !== conversationId)
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
    if (grant.kind !== "work" || grant.status !== "active" || grant.remainingS <= 0
      || grant.conversationId !== conversationId || grant.remainingS > minutes * 60
      || !grant.scope.classes?.length || !grant.scope.targets?.length || grant.scope.classes.some(c => !classes.includes(c as "read" | "write"))
      || grant.scope.targets.some(target => target.identifiers.some(identifier =>
        (target.actions ?? grant.scope.classes!).some(action => !targets.some(proposed => matches({ type: target.type, identifier, label: identifier }, proposed, action))))))
      throw new Error("The returned work grant exceeds the confirmed places or actions. Inspect active grants.");
    return this.#keep(grant);
  }

  async pause(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.pauseGrant(id, signal)); }
  async resume(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.resumeGrant(id, signal)); }
  async revoke(id: string, signal?: AbortSignal): Promise<AgentGrant> { return this.#keep(await this.#agent.client.agent!.revokeGrant(id, signal)); }

  /** The caller must show and confirm the added time/places; the server may narrow or refuse it. */
  async extend(id: string, more: number, places: readonly GrantPlace[] = [], shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
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
    if (!this.available || call.requiredByRule || !["read", "write"].includes(call.toolClass)) return false;
    const entry = this.#agent.profile.hostToolContract.find(t => t.name === call.toolName);
    if (entry?.approval === "always") return false;
    const key = JSON.stringify([call.conversationId, call.turnId, call.callId]);
    if (dispatch ? this.#used.get(key) !== id : this.#used.has(key)) return false;
    try {
      const grant = this.#keep(await this.#agent.client.agent!.getGrant(id, signal));
      if (!this.offers(grant.kind === "time" ? "time" : "grant")
        || !this.#agent.profile.approvals!.grantClasses.includes(call.toolClass as "read" | "write")) return false;
      // Spent may be the very call already charged by the server's grant_used event.
      if (!["active", "spent"].includes(grant.status) || Date.parse(grant.expiresAt) <= Date.parse(grant.serverNow)
        || grant.remainingS <= 0 || grant.callsUsed < 1 || grant.maxCalls !== null && grant.callsUsed > grant.maxCalls
        || grant.conversationId !== null && grant.conversationId !== call.conversationId) return false;
      let holds = grant.kind === "time" && grant.scope.tools?.length === 1 && grant.scope.tools[0] === call.toolName;
      if (grant.kind === "work" && this.#resolve && entry?.targetType && entry.targetArgument && grant.scope.classes?.includes(call.toolClass)) {
        const identifier = pointer(call.arguments, entry.targetArgument);
        if (typeof identifier === "string") {
          const place = await this.#resolve({ type: entry.targetType, identifier, label: identifier }, signal);
          holds = !!place && (grant.scope.targets ?? []).some(target => matches(place, target, call.toolClass));
        }
      }
      if (holds && !dispatch) {
        if (this.#used.size >= 1000) return false; // bounded session guard; never evict replay protection to permit a call
        this.#used.set(key, id);
      }
      return holds;
    } catch (error) { if (signal.aborted) throw signal.reason ?? error; return false; }
  }
}
