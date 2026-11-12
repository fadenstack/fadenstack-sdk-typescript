import {
  FadenstackError,
  HOST_TOOL_DISPATCH_FEATURE,
  SDK_LANGUAGE,
  SDK_VERSION,
  decideTool,
  effectiveToolClass,
  narrowestMode,
  parseToolClass,
  type AgentPrincipal,
  type AgentProfile,
  type AppManifest,
  type FadenstackClient,
  type ManifestTool,
  type SkillOption,
  type ToolClass,
  type ToolDefinition,
  type ToolMode,
} from "@fadenstack/client";

import type { PermissionMode } from "./approvals.js";
import { IndexedDbApprovalStore, MemoryApprovalStore, type ApprovalStore, type StoredApproval } from "./approvalStore.js";
import { IndexedDbSessionStore } from "./indexedDbSessionStore.js";
import { MemorySessionStore, type SessionStore } from "./sessionStore.js";
import { StepUpProofs, isStepUpHandler, type StepUpHandler } from "./stepUp.js";
import { userStoreName } from "./userData.js";

import { AgentBuilder, UNDESCRIBED_APP_NAME, type AgentSettings, type AppDescription } from "./builder.js";
import { EventReporter } from "./reporter.js";
import { AgentSession } from "./session.js";
import type { AgentContext } from "./stages.js";
import { toDefinition, withToolClass, type AgentTool, type ToolOutput } from "./tools.js";
import { newId, type SessionInfo } from "./transcript.js";
import { AgentGrants, isGrantHandler, type GrantHandler } from "./grants.js";

/** How old the profile may be when a session starts or opens before it is read again (39 F8). */
export const PROFILE_MAX_AGE_MS = 60_000;

/**
 * An agent served by a Fadenstack server and run on this device: its profile, its tools, and its sessions.
 * The loop runs here; every model call goes through the gateway. .NET: `Fadenstack.Agents.FadenstackAgent`.
 */
export class FadenstackAgent {
  /** @internal */
  readonly settings: AgentSettings;
  /** @internal */
  readonly reporter: EventReporter;
  readonly grants: AgentGrants;
  /** @internal The proof of a fresh sign-in for Bypass while it lasts, in memory only (sdk/41). */
  readonly stepUps: StepUpProofs;
  /** @internal The time, in milliseconds, for the profile's age and the grants' remaining time; tests set it. */
  clock: () => number = () => Date.now();
  #profile: AgentProfile | undefined;
  #profileRead = 0;
  #context: AgentContext | undefined;
  #tools: readonly AgentTool[] = [];
  #sourceTools: readonly AgentTool[] = [];
  // The stores the host did not pass: in the signed-in user's own database (`userStoreName`).
  #sessions: SessionStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #storesFor: string | undefined;
  #starting: Promise<void> | undefined;
  #warned = false;
  #hostPolicySeen = false;

  private constructor(settings: AgentSettings) {
    this.settings = settings;
    this.reporter = new EventReporter(settings.client, settings.report);
    this.grants = new AgentGrants(this, settings.grantPlaceResolver);
    this.stepUps = new StepUpProofs(this);
  }

  /** @internal The builder's way in: `FadenstackAgent.createBuilder()...build()`. */
  static create(settings: AgentSettings): FadenstackAgent {
    return new FadenstackAgent(settings);
  }

  static createBuilder(): AgentBuilder {
    return new AgentBuilder();
  }

  get slug(): string {
    return this.settings.agent;
  }

  get client(): FadenstackClient {
    return this.settings.client;
  }

  /** The app the agent runs in, as the host described it (`describeApp`); undefined when it did not. */
  get app(): AppDescription | undefined {
    return this.settings.app.name === UNDESCRIBED_APP_NAME ? undefined : this.settings.app;
  }

  /** The agent's profile, once `start` ran. */
  get profile(): AgentProfile {
    if (!this.#profile) throw new Error("Call start() first.");
    return this.#profile;
  }

  get isStarted(): boolean {
    return this.#profile !== undefined;
  }

  /** @internal What tool sources and modules see of the agent, once `start` ran. */
  get context(): AgentContext {
    if (!this.#context) throw new Error("Call start() first.");
    return this.#context;
  }

  /** `ask`, or `bypass` when the app set it (`usePermissionMode`). */
  get permissionMode(): PermissionMode {
    return this.settings.permissionMode;
  }

  /** Once negotiated, loss of policy-check support fails closed until a new authenticated agent is built. */
  get hostToolPolicyChecks(): boolean {
    return this.#hostPolicySeen || this.settings.requireHostToolPolicyChecks;
  }

  /** Refresh mutable approval controls; an identity/contract change requires a new reviewed agent context. */
  async refreshPolicy(signal?: AbortSignal): Promise<void> {
    const before = this.profile;
    const fresh = await this.client.agent!.getProfile(signal);
    this.#assertHostPolicySupport(fresh);
    const binding = (p: AgentProfile) => JSON.stringify({ id: p.id, slug: p.slug, version: p.version, draft: p.draft,
      principal: p.principal, contract: p.hostToolContract, instructions: p.instructionsSha256,
      modules: p.requiredClientModules, extensions: p.extensions });
    if (binding(before) !== binding(fresh)) throw new FadenstackError("The agent identity or published contract changed. Reconnect before running tools.");
    this.#profile = fresh;
    this.#profileRead = this.clock();
    if (this.#context) this.#context = { ...this.#context, profile: fresh };
  }

  /**
   * @internal Reads the profile again when a session starts or opens and it is older than `PROFILE_MAX_AGE_MS` (39 F8): a
   * ceiling an administrator lowered, a highest level, or a tool's class or approval reach the next session without a
   * restart. The tools of the agent's sources (local MCP) stay as they were. When the server cannot be reached the
   * profile held stays: every model call goes through the server anyway, and a session on this device still opens. The
   * agent itself -- who it is and who is signed in -- must be the same one; a change throws.
   */
  async refreshProfile(signal?: AbortSignal): Promise<void> {
    const before = this.#profile;
    if (!before || this.clock() - this.#profileRead < PROFILE_MAX_AGE_MS) return;
    let fresh: AgentProfile;
    try {
      fresh = await this.client.agent!.getProfile(signal);
      this.#checkModules(fresh);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return; // the profile held stays
    }
    this.#assertHostPolicySupport(fresh); // not swallowed above: a server that dropped the checks is not trusted with the old ones
    const who = (p: AgentProfile) => JSON.stringify({ id: p.id, slug: p.slug, principal: p.principal });
    if (who(before) !== who(fresh)) throw new FadenstackError("The agent or the signed-in user changed. Reconnect before starting a session.");
    this.#tools = this.#compose(this.#settleHostTools(fresh), this.#sourceTools);
    this.#profile = fresh;
    this.#profileRead = this.clock();
    if (this.#context) this.#context = { ...this.#context, profile: fresh };
  }

  #assertHostPolicySupport(profile: AgentProfile): void {
    const supported = profile.features.includes(HOST_TOOL_DISPATCH_FEATURE);
    if ((this.settings.requireHostToolPolicyChecks || this.#hostPolicySeen) && !supported)
      throw new FadenstackError("This agent requires fresh central host-tool dispatch checks. The gateway does not advertise support.");
    if (supported) this.#hostPolicySeen = true;
  }

  /** The last report to the server that failed, for diagnostics (reports never fail a turn). */
  get lastReportError(): unknown {
    return this.reporter.lastError;
  }

  /** The tools the agent runs, with their effective classes, once started. */
  get tools(): readonly AgentTool[] {
    return this.#tools;
  }

  /**
   * Who opens the second sign-in for Bypass (sdk/41): the app's own (`useStepUpHandler`), else the approval handler when it
   * is one. Without one there is no Bypass: the agent announces none, and the app runs in `auto`.
   */
  get stepUpHandler(): StepUpHandler | undefined {
    return this.settings.stepUp ?? (isStepUpHandler(this.settings.approvals) ? this.settings.approvals : undefined);
  }

  /** Who draws the grant card (the Bypass confirmation, the work card): the app's own, else the approval handler when it does. */
  get grantHandler(): GrantHandler | undefined {
    return this.settings.grantHandler ?? (isGrantHandler(this.settings.approvals) ? this.settings.approvals : undefined);
  }

  /**
   * Whether a person may switch approvals off in a conversation with this agent now (sdk/09 L-57): the organisation
   * allows it, the agent's version goes up to it, and no ceiling is lower -- as the server says in the profile, to a client
   * that announced the flow (an agent with a step-up handler does).
   */
  get bypassOffered(): boolean {
    return this.grants.bypassOffered;
  }

  /**
   * The most any session may use: the narrowest of the profile's ceiling and the agent's highest level, where the
   * server sets them, else `auto`. A level this SDK does not know reads as `read_only` (the profile's parser), never
   * as none. Bypass only where the server offers it (`bypassOffered`); otherwise `auto`.
   */
  get ceiling(): ToolMode {
    const modes = this.#profile?.toolModes;
    const top = narrowestMode(modes?.ceiling ?? "bypass", modes?.max ?? "bypass");
    return top === "bypass" && !this.bypassOffered ? "auto" : top;
  }

  /**
   * The mode new sessions start in: the agent's default level from the server (`ask` from an older server, or for a
   * level this SDK does not know), no higher than the app's own default (`useDefaultToolMode`) and the ceiling. Never
   * Bypass: that is switched on in a conversation, with the person's confirmation.
   */
  get defaultToolMode(): ToolMode {
    return narrowestMode(narrowestMode(this.#profile?.toolModes.default ?? "ask", this.settings.defaultMode), this.ceiling);
  }

  /**
   * Loads the profile, checks the modules the agent requires, and settles the tools: host tools outside the
   * agent's contract are dropped, the others get the stricter of their own class and the contract's. Without a
   * contract -- or for an entry without a risk -- nobody on the server vouched for a tool: it is unclassified, and
   * always asks.
   */
  start(signal?: AbortSignal): Promise<void> {
    if (this.#profile) return Promise.resolve();
    this.#starting ??= this.#start(signal).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /**
   * Keeps the language the user picked for all their clients and the console (null: each follows its host), and
   * in this agent's profile. Returns the language kept.
   */
  async setUserLanguage(language: string | null, signal?: AbortSignal): Promise<string | null> {
    const kept = await this.client.agent!.setUserLanguage(language, signal);
    if (this.#profile) this.#profile = { ...this.#profile, user: { ...this.#profile.user, language: kept } };
    return kept;
  }

  /**
   * The skills the user can pick for a message (`SendOptions.skills`); none when the server offers no skills.
   * `query` narrows them by name or description on the server.
   */
  async listSkills(query?: string, signal?: AbortSignal): Promise<SkillOption[]> {
    if (this.#profile && !this.#profile.skills) return [];
    const options: { query?: string; limit: number; signal?: AbortSignal } = { limit: 100 };
    if (query) options.query = query;
    if (signal) options.signal = signal;
    return (await this.client.agent!.listSkills(options)).skills;
  }

  /** Loads the profile again (after a new version was published) and settles the tools anew. */
  async restart(signal?: AbortSignal): Promise<void> {
    this.#profile = undefined;
    await this.start(signal);
  }

  #checkModules(profile: AgentProfile): void {
    const missing = profile.requiredClientModules.filter((m) => !this.settings.modules.includes(m));
    if (missing.length) {
      throw new FadenstackError(`The agent '${this.slug}' needs the module(s) ${missing.join(", ")}; add them to the builder.`);
    }
  }

  /** The host tools the profile's contract allows, with the stricter of their own class and the contract's. */
  #settleHostTools(profile: AgentProfile): AgentTool[] {
    const contract = new Map(profile.hostToolContract.map((t) => [t.name, t]));
    const tools: AgentTool[] = [];
    for (const tool of this.settings.tools) {
      const entry = contract.get(tool.name);
      if (contract.size > 0 && !entry) continue; // the gateway refuses it anyway; not offering it keeps the model from trying
      const risk: ToolClass = entry ? parseToolClass(entry.risk) : "unknown";
      const toolClass = risk === "unknown" ? "unknown" : effectiveToolClass(tool.toolClass, risk);
      tools.push(toolClass === tool.toolClass ? tool : withToolClass(tool, toolClass));
    }
    return tools;
  }

  // A host tool wins over a source's of the same name.
  #compose(hosts: readonly AgentTool[], fromSources: readonly AgentTool[]): AgentTool[] {
    const tools = [...hosts];
    for (const tool of fromSources) if (!tools.some((t) => t.name === tool.name)) tools.push(tool);
    return tools;
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const profile = await this.client.agent!.getProfile(signal);
    this.#assertHostPolicySupport(profile);
    this.#checkModules(profile);
    const hosts = this.#settleHostTools(profile);
    const context: AgentContext = {
      client: this.client,
      profile,
      report: (event) => this.reporter.reportNow([event]),
    };
    const fromSources: AgentTool[] = [];
    for (const source of this.settings.sources) {
      for (const tool of await source.getTools(context, signal)) {
        if (!hosts.some((t) => t.name === tool.name) && !fromSources.some((t) => t.name === tool.name)) fromSources.push(tool);
      }
    }
    this.#sourceTools = fromSources;
    this.#tools = this.#compose(hosts, fromSources);
    this.#profile = profile;
    this.#profileRead = this.clock();
    this.#context = context;
    this.#settleStores(profile.principal);
    if (this.settings.permissionMode === "bypass" && !this.#warned) {
      if (!this.bypassOffered) {
        this.#warned = true;
        console.warn(`The agent '${this.slug}' is set to bypass mode, which this server does not offer for it: its sessions ` +
          "run in auto instead. Destructive and unclassified calls, an admin's \"Ask first\" rule and the gateway's own questions still ask.");
      } else if (!this.stepUpHandler) {
        this.#warned = true;
        console.warn(`The agent '${this.slug}' is set to bypass mode, but the app opens no second sign-in (useStepUpHandler): ` +
          "Bypass needs one, so its sessions run in auto (sdk/41).");
      }
    }
    if (this.settings.report) void this.#reportManifest();
  }

  /**
   * The stores the host did not pass: in the signed-in user's own IndexedDB database, so two people in one browser profile
   * never see each other's chats or "Allow always" -- or, from a gateway that names no user, in the shared databases an
   * older SDK used. What an older SDK kept in the shared databases is never moved to a user: in a browser profile nobody can
   * say whose it is. (39 F10; sdk/46 F1.)
   */
  #settleStores(principal: AgentPrincipal | undefined): void {
    const key = principal ? `${principal.tenantId}\n${principal.userId}` : "";
    if (this.#storesFor === key) return;
    (this.#sessions as { close?: () => void } | undefined)?.close?.();
    (this.#approvalStore as { close?: () => void } | undefined)?.close?.();
    const indexed = !!globalThis.indexedDB;
    this.#sessions = this.settings.sessions ? undefined
      : indexed ? new IndexedDbSessionStore({ name: userStoreName("fadenstack-sessions", principal) }) : new MemorySessionStore();
    this.#approvalStore = this.settings.approvalStore ? undefined
      : indexed ? new IndexedDbApprovalStore({ name: userStoreName("fadenstack-approvals", principal) }) : new MemoryApprovalStore();
    this.#storesFor = key;
  }

  /** The host's session store, or the default one once `start` knows whose it is. */
  get sessionStore(): SessionStore {
    const store = this.settings.sessions ?? this.#sessions;
    if (!store) throw new Error("Call start() first.");
    return store;
  }

  /** The host's store for "Allow always", or the default one once `start` knows whose it is. */
  get approvalStore(): ApprovalStore {
    const store = this.settings.approvalStore ?? this.#approvalStore;
    if (!store) throw new Error("Call start() first.");
    return store;
  }

  // The default stores need the profile (whose database); a store the host passed does not.
  async #startUnless(hostStore: unknown, signal?: AbortSignal): Promise<void> {
    if (hostStore === undefined) await this.start(signal);
  }

  /**
   * Tells the server what this app brings: every host tool with the class its developer gave it -- also those the
   * contract does not list yet, which is how the server learns of them -- and the app's context and greeting.
   * Never fails the start: an older server without the route, or no network, just means no report.
   */
  async #reportManifest(): Promise<void> {
    const { app, tools } = this.settings;
    const manifest: AppManifest = {
      app: { name: app.name, ...(app.version !== undefined ? { version: app.version } : {}) },
      sdk: { language: SDK_LANGUAGE, version: SDK_VERSION },
      tools: tools.filter((t) => t.source === "host").map((t) => ({
        name: t.name,
        parameters: t.parameters,
        toolClass: t.toolClass,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.openWorld !== undefined ? { openWorld: t.openWorld } : {}),
        ...(t.output !== undefined ? { output: manifestOutput(t.output) } : {}),
      })),
      ...(app.context ? { context: app.context } : {}),
      ...(app.ui ? { ui: app.ui } : {}),
    };
    try {
      await this.client.agent!.reportManifest(manifest);
    } catch {
      // nothing to do: the server learns of the tools at the next start
    }
  }

  /** A new session, in the agent's default mode (`ask`) unless `toolMode` says otherwise. */
  async startSession(toolMode?: ToolMode): Promise<AgentSession> {
    await this.start();
    await this.refreshProfile();
    const session = new AgentSession(this, newId(), [], toolMode ?? this.defaultToolMode);
    await session.writeStart();
    return session;
  }

  /**
   * A session from this device's store, to go on with in its last mode. A conversation whose Bypass grant still lives opens
   * in Bypass, with its marker; one without never does (owner, 2026-11-09: parallel chats never break). The grants are read
   * from the server first; offline, the copy as it is.
   */
  async openSession(sessionId: string): Promise<AgentSession> {
    await this.start();
    await this.refreshProfile();
    const entries = await this.sessionStore.read(this.slug, sessionId);
    if (entries.length === 0) throw new Error(`No session '${sessionId}' for '${this.slug}' on this device.`);
    if (this.grants.available) {
      try {
        await this.grants.refresh();
      } catch (error) {
        if (!(error instanceof FadenstackError)) throw error; // offline or refused: the copy as it is; the next turn settles it
      }
    }
    // The grant decides, not the transcript: Bypass switched on before the chat's first message left no turn in it.
    const lives = this.grants.live.some((g) => g.kind === "bypass" && g.conversationId === sessionId);
    const before = AgentSession.lastMode(entries) ?? this.defaultToolMode;
    const session = new AgentSession(this, sessionId, entries, lives ? "bypass" : before);
    session.reopened(before);
    return session;
  }

  /** This device's sessions of the agent: the signed-in user's, so the agent starts first unless the host keeps them. */
  async listSessions(): Promise<SessionInfo[]> {
    await this.#startUnless(this.settings.sessions);
    return this.sessionStore.list(this.slug);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#startUnless(this.settings.sessions);
    await this.sessionStore.delete(this.slug, sessionId);
  }

  /**
   * Forgets what the user allowed always on this device for this agent: every tool, or `tool` only. (What a chat
   * allowed ends with that chat: `AgentSession.resetApprovals`.)
   */
  async resetApprovals(tool?: string): Promise<void> {
    await this.#startUnless(this.settings.approvalStore);
    await this.approvalStore.remove(this.slug, tool);
  }

  /**
   * What the user allowed always on this device for this agent, for Settings > Approvals (38 §7); each is ended with
   * `resetApprovals`. The grants the server holds are in `grants`.
   */
  async listApprovals(): Promise<StoredApproval[]> {
    await this.#startUnless(this.settings.approvalStore);
    return this.approvalStore.list(this.slug);
  }

  /** Sends what is left to report. */
  flush(): Promise<void> {
    return this.reporter.flush();
  }

  async dispose(): Promise<void> {
    await this.flush();
    (this.#sessions as { close?: () => void } | undefined)?.close?.();
    (this.#approvalStore as { close?: () => void } | undefined)?.close?.();
    for (const source of this.settings.sources) await source.dispose?.();
  }

  /** The tools a mode offers the model. */
  offer(mode: ToolMode): ToolDefinition[] {
    return this.#tools.filter((t) => decideTool(mode, t.toolClass) !== "hidden").map(toDefinition);
  }

  find(name: string): AgentTool | undefined {
    return this.#tools.find((t) => t.name === name);
  }
}

/** A declared output as the manifest names it: the edit kind only when it is fixed, not decided per call. */
function manifestOutput(output: ToolOutput): NonNullable<ManifestTool["output"]> {
  return {
    argument: output.argument,
    mediaType: output.mediaType,
    ...(typeof output.edit === "string" ? { editKind: output.edit } : {}),
  };
}
