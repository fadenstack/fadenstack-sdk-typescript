import {
  FadenstackError,
  HOST_TOOL_DISPATCH_FEATURE,
  writeLog,
  SDK_LANGUAGE,
  SDK_VERSION,
  decideTool,
  narrowestMode,
  type AgentPrincipal,
  type AgentProfile,
  type AppManifest,
  type FadenstackClient,
  type ManifestTool,
  type ReasoningEffort,
  type SkillOption,
  type ToolDefinition,
  type ToolMode,
} from "@fadenstack/client";

import type { PermissionMode } from "./approvals.js";
import { type ApprovalStore, type StoredApproval } from "./approvalStore.js";
import { DefaultStores, buildExport, deleteUserDatabases, type DataDeletion, type MyDataExport } from "./dataRights.js";
import { DEFAULT_RETENTION, withinServerRetention, type SessionStore } from "./sessionStore.js";
import type { StoreProblem } from "./storeSupport.js";
import { StepUpProofs, isStepUpHandler, type StepUpHandler } from "./stepUp.js";
import {
  IndexedDbReasoningStore, MemoryReasoningStore, ReasoningChoices, reasoningEffort, reasoningLevelOf, reasoningStoreName,
  type ReasoningLevel, type ReasoningStore,
} from "./reasoning.js";

import { AgentBuilder, UNDESCRIBED_APP_NAME, type AgentSettings, type AppDescription } from "./builder.js";
import { EventReporter } from "./reporter.js";
import { ChatSession } from "./session.js";
import { isChangingToolSource, type AgentContext, type ToolSource } from "./stages.js";
import { AgentLog } from "./log.js";
import { FIND_TOOL_NAME, isCoreToolSource, settleHostTools, toDefinition, type AgentTool, type ToolOutput } from "./tools.js";
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
  // Each source's tools in the builder's order, and the sources that said they changed since the last turn began.
  #sourceTools: { source: ToolSource; tools: readonly AgentTool[] }[] = [];
  readonly #changed = new Set<ToolSource>();
  readonly #unsubscribe: (() => void)[] = [];
  // Names that were offered and went away: a call of one is refused as such, not as unknown.
  readonly #gone = new Set<string>();
  #refreshing: Promise<void> = Promise.resolve();
  // The stores the host did not pass: in the signed-in user's own database (`userStoreName`).
  #sessions: SessionStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #storesFor: string | undefined;
  #reasoningStore: ReasoningStore | undefined;
  #reasoningChoices: ReasoningChoices = ReasoningChoices.everything;
  #reasoningPick: ReasoningLevel | undefined;
  #defaults: DefaultStores | undefined;
  #problems = 0;
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
      writeLog(this.settings.logger, AgentLog.profileRereadFailed, { Agent: this.slug, ErrorType: error instanceof Error ? error.name : typeof error });
      return; // the profile held stays
    }
    this.#assertHostPolicySupport(fresh); // not swallowed above: a server that dropped the checks is not trusted with the old ones
    const who = (p: AgentProfile) => JSON.stringify({ id: p.id, slug: p.slug, principal: p.principal });
    if (who(before) !== who(fresh)) throw new FadenstackError("The agent or the signed-in user changed. Reconnect before starting a session.");
    const offered = this.#tools;
    this.#tools = this.#compose(settleHostTools(this.settings.tools, fresh), this.#sourceTools);
    this.#markGone(offered, this.#tools);
    this.#reasoningChoices = ReasoningChoices.fromUi(fresh.ui); // a maximum the server lowered counts from the next message
    this.#profile = fresh;
    this.#applyRetention(fresh);
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

  /**
   * The host tools, then each source's tools in the builder's order; a host tool wins over a source's of the same name, the
   * first source over a later one. `find_tool` comes only from the SDK's own source: an app's source's is left out.
   */
  #compose(hosts: readonly AgentTool[], fromSources: readonly { source: ToolSource; tools: readonly AgentTool[] }[]): AgentTool[] {
    const tools = [...hosts];
    const names = new Set(tools.map((t) => t.name));
    for (const { source, tools: list } of fromSources) for (const tool of list) {
      if (tool.name === FIND_TOOL_NAME && !isCoreToolSource(source)) continue;
      if (!names.has(tool.name)) {
        names.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** Keeps the names of the tools that were offered and are no more; a name offered again is taken off. */
  #markGone(before: readonly AgentTool[], after: readonly AgentTool[]): void {
    const now = new Set(after.map((t) => t.name));
    for (const tool of before) if (!now.has(tool.name)) this.#gone.add(tool.name);
    for (const name of now) this.#gone.delete(name);
  }

  /** Whether a tool of this name was offered and went away: a call to it is refused as such, not as unknown. */
  isGone(name: string): boolean {
    return this.#gone.has(name);
  }

  /**
   * @internal Asks the sources that said they changed (`ChangingToolSource`) for their tools again, and settles them as at
   * start. Called at the start of a turn, never inside one, so a turn's tools do not change under it. A tool that went away
   * stays refused by name. A source that fails keeps the tools it had.
   */
  refreshTools(signal?: AbortSignal): Promise<void> {
    if (this.#changed.size === 0 || !this.#context) return Promise.resolve();
    const run = this.#refreshing.then(async () => {
      const changed = [...this.#changed];
      this.#changed.clear();
      if (changed.length === 0 || !this.#context) return;
      const before = this.#tools;
      for (const source of changed) {
        let fresh: readonly AgentTool[];
        try {
          fresh = await source.getTools(this.#context, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          writeLog(this.settings.logger, AgentLog.toolsRefreshFailed, { Agent: this.slug, ErrorType: error instanceof Error ? error.name : typeof error });
          continue; // it keeps the tools it had
        }
        const at = this.#sourceTools.findIndex((s) => s.source === source);
        if (at >= 0) this.#sourceTools[at] = { source, tools: fresh };
      }
      this.#tools = this.#compose(settleHostTools(this.settings.tools, this.profile), this.#sourceTools);
      this.#markGone(before, this.#tools);
      writeLog(this.settings.logger, AgentLog.toolsRefreshed, { Agent: this.slug, Sources: changed.length, Tools: this.#tools.length });
    });
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const profile = await this.client.agent!.getProfile(signal);
    this.#assertHostPolicySupport(profile);
    this.#checkModules(profile);
    const hosts = settleHostTools(this.settings.tools, profile);
    const context: AgentContext = {
      client: this.client,
      profile,
      report: (event) => this.reporter.reportNow([event]),
    };
    const fromSources: { source: ToolSource; tools: readonly AgentTool[] }[] = [];
    for (const source of this.settings.sources) {
      if (isChangingToolSource(source)) this.#unsubscribe.push(source.onChanged(() => { this.#changed.add(source); }));
      fromSources.push({ source, tools: await source.getTools(context, signal) });
    }
    this.#sourceTools = fromSources;
    this.#tools = this.#compose(hosts, fromSources);
    this.#settleStores(profile.principal);
    this.#reasoningChoices = ReasoningChoices.fromUi(profile.ui);
    this.#reasoningPick = await this.#picks?.get(this.slug).catch(() => undefined);
    this.#profile = profile;
    this.#profileRead = this.clock();
    this.#context = context;
    this.#applyRetention(profile);
    const dropped = this.settings.tools.filter((t) => !hosts.some((h) => h.name === t.name));
    for (const tool of dropped) writeLog(this.settings.logger, AgentLog.toolDropped, { Tool: tool.name });
    writeLog(this.settings.logger, AgentLog.profileLoaded, { Agent: this.slug, Version: profile.version ?? null, Edition: profile.edition,
      FeatureCount: profile.features.length, UserPartition: profile.principal !== undefined });
    writeLog(this.settings.logger, AgentLog.toolsSettled, { Agent: this.slug, HostTools: hosts.length,
      SourceTools: this.#tools.length - hosts.length, Dropped: dropped.length });
    if (this.settings.permissionMode === "bypass" && !this.#warned) {
      if (!this.bypassOffered) {
        this.#warned = true;
        writeLog(this.settings.logger, AgentLog.bypassMode, { Agent: this.slug });
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
    this.#defaults?.close();
    (this.#reasoningStore as { close?: () => void } | undefined)?.close?.();
    const indexed = !!globalThis.indexedDB;
    // A host that keeps both stores itself has taken over the device's storage: the pick then lasts for the run only.
    this.#reasoningStore = this.settings.reasoningStore ? undefined
      : this.settings.sessions && this.settings.approvalStore ? new MemoryReasoningStore()
      : indexed ? new IndexedDbReasoningStore({ name: reasoningStoreName(principal) }) : new MemoryReasoningStore();
    const defaults = new DefaultStores({
      principal,
      retention: this.settings.sessionRetention ?? DEFAULT_RETENTION,
      ...(this.settings.secretProtector ? { protector: this.settings.secretProtector } : {}),
      onProblem: (problem) => this.#storeProblem(problem),
      sessions: !this.settings.sessions,
      approvals: !this.settings.approvalStore,
    });
    this.#defaults = defaults;
    this.#sessions = defaults.sessions;
    this.#approvalStore = defaults.approvals;
    this.#storesFor = key;
  }

  // -- thinking -----------------------------------------------------------------------------------------------

  /**
   * The levels of thinking the agent offers: Auto, Off, and Low, Medium and High up to the maximum the profile's
   * `ui.reasoning.max` sets, if any (`minimal` caps at none, `max` sets no cap). .NET: `ReasoningChoices`.
   */
  get reasoningChoices(): ReasoningChoices {
    return this.#reasoningChoices;
  }

  /**
   * The level this person picked for this agent, if any, kept per person and agent (in the signed-in user's own IndexedDB
   * database, unless the host keeps both stores itself: then for the run only). A pick above a maximum the server set later
   * still counts, and is lowered to it.
   */
  get reasoningChoice(): ReasoningLevel | undefined {
    return this.#reasoningPick;
  }

  /**
   * How long new messages think: the person's pick, else what the app set with `useReasoning`, else Auto -- each lowered to
   * the server's maximum, if it sets one.
   */
  get reasoning(): ReasoningLevel {
    return this.#resolveReasoning().level;
  }

  /** @internal What a request carries when nothing else was set for the session; undefined (no field) for Auto without a maximum. */
  get requestEffort(): ReasoningEffort | undefined {
    return this.#resolveReasoning().effort;
  }

  /** @internal What a request carries for a level the session was given: Auto is the maximum, if there is one. */
  effortFor(level: ReasoningLevel): ReasoningEffort | undefined {
    return level === "auto" ? this.#reasoningChoices.max : this.#reasoningChoices.cap(reasoningEffort(level));
  }

  get #picks(): ReasoningStore | undefined {
    return this.settings.reasoningStore ?? this.#reasoningStore;
  }

  #resolveReasoning(): { level: ReasoningLevel; effort: ReasoningEffort | undefined } {
    const choices = this.#reasoningChoices;
    const capped = (effort: ReasoningEffort | undefined) => ({ level: reasoningLevelOf(effort), effort });
    if (this.#reasoningPick) {
      return this.#reasoningPick === "auto" ? { level: "auto", effort: choices.max } : capped(choices.cap(reasoningEffort(this.#reasoningPick)));
    }
    // The app's own effort goes out exactly as it set it (extra high stays extra high) unless the maximum is lower.
    return this.settings.reasoning ? capped(choices.cap(this.settings.reasoning)) : { level: "auto", effort: choices.max };
  }

  /**
   * Keeps the person's pick for this agent (undefined forgets it), from the next message on; a running turn is not changed.
   * A level the agent does not offer is ignored. Returns the level new messages think at.
   */
  async setReasoning(level: ReasoningLevel | undefined, signal?: AbortSignal): Promise<ReasoningLevel> {
    await this.start(signal);
    if (level === undefined || this.#reasoningChoices.offers(level)) {
      this.#reasoningPick = level;
      try {
        await this.#picks?.set(this.slug, level);
      } catch {
        // the pick still holds for this run; it is just not remembered
      }
    }
    return this.reasoning;
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
      // The host's tools, and those of its tool sources that are host tools (on request): the server learns of them the same way.
      tools: [...tools, ...this.settings.sources.flatMap((s) => s.declared?.() ?? []).filter((t) => !tools.some((h) => h.name === t.name))]
        .filter((t) => t.source === "host").map((t) => ({
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
  async startSession(toolMode?: ToolMode): Promise<ChatSession> {
    await this.start();
    await this.refreshProfile();
    const session = new ChatSession(this, newId(), [], toolMode ?? this.defaultToolMode);
    await session.writeStart();
    return session;
  }

  /**
   * A session from this device's store, to go on with in its last mode. A conversation whose Bypass grant still lives opens
   * in Bypass, with its marker; one without never does (owner, 2026-11-09: parallel chats never break). The grants are read
   * from the server first; offline, the copy as it is.
   */
  async openSession(sessionId: string): Promise<ChatSession> {
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
    const before = ChatSession.lastMode(entries) ?? this.defaultToolMode;
    const session = new ChatSession(this, sessionId, entries, lives ? "bypass" : before);
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
   * allowed ends with that chat: `ChatSession.resetApprovals`.)
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
    this.#defaults?.close();
    (this.#reasoningStore as { close?: () => void } | undefined)?.close?.();
    for (const stop of this.#unsubscribe.splice(0)) stop();
    for (const source of this.settings.sources) await source.dispose?.();
  }

  /** The stricter of the app's limits and the server's (`local_retention`) for the sessions the SDK keeps; a limit the server leaves out stays. */
  #applyRetention(profile: AgentProfile): void {
    this.#defaults?.setRetention(withinServerRetention(this.settings.sessionRetention ?? DEFAULT_RETENTION, profile.localRetention));
  }

  #storeProblem(problem: StoreProblem): void {
    this.#problems++;
    try {
      this.settings.onStoreProblem?.(problem);
    } catch {
      // a host's handler never breaks a read
    }
  }

  /**
   * The signed-in user's data on this device as one JSON document (an access request, GDPR Art. 15 and 20): every session of
   * every agent the SDK's stores hold, decrypted, and the "Allow always" approvals. Without a user from the gateway these
   * are the shared databases of an older SDK. Sign-in tokens are never included, nor is what the server keeps. A store the
   * host passed is read for this agent only. .NET: `ExportMyDataAsync` (a ZIP there; a document here, which the host saves
   * or offers as a download as it likes).
   */
  async exportMyData(signal?: AbortSignal): Promise<MyDataExport> {
    await this.start(signal);
    return buildExport(this.sessionStore, this.approvalStore, this.slug, () => this.#problems);
  }

  /**
   * Deletes the signed-in user's data on this device (an erasure request, GDPR Art. 17): the user's IndexedDB databases --
   * sessions, "Allow always" -- and their key, so that no copy left anywhere (a backup of the profile) can ever be read.
   * Afterwards the stores start empty. It does not sign out (that is the host's call). It leaves stores the host passed to
   * their owner -- they may hold other people's data -- but says so in the result, so a host never believes a person's data
   * gone that its own store still keeps. What the server keeps is for its operator to erase. .NET: `DeleteMyDataAsync`.
   */
  async deleteMyData(signal?: AbortSignal): Promise<DataDeletion> {
    await this.start(signal);
    const principal = this.profile.principal;
    // The SDK's own preferences store goes too (a host's own reasoning store stays the host's): closed first, an open
    // database blocks its deletion.
    if (!this.settings.reasoningStore) (this.#reasoningStore as { close?: () => void } | undefined)?.close?.();
    await this.#defaults?.closeAsync();
    let storesCleared = 0;
    try {
      storesCleared = await deleteUserDatabases(principal);
    } finally {
      this.#storesFor = undefined; // new, empty stores (and a new key) at the next use
      this.#settleStores(principal);
      this.#applyRetention(this.profile);
      if (!this.settings.reasoningStore) this.#reasoningPick = undefined;
    }
    const hostSessionStoreLeft = this.settings.sessions !== undefined;
    const hostApprovalStoreLeft = this.settings.approvalStore !== undefined;
    return { storesCleared, hostSessionStoreLeft, hostApprovalStoreLeft, hostStoresLeft: hostSessionStoreLeft || hostApprovalStoreLeft };
  }

  /** The tools a mode offers the model in `session` (when given): the mode's, and those the tool's scope offers. */
  offer(mode: ToolMode, session?: ChatSession): ToolDefinition[] {
    return this.#tools
      .filter((t) => (!t.scope || (session !== undefined && t.scope.offers(t, session))) && decideTool(mode, t.toolClass) !== "hidden")
      .map(toDefinition);
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
