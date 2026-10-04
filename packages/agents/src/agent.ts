import {
  FadenError,
  SDK_LANGUAGE,
  SDK_VERSION,
  decideTool,
  effectiveToolClass,
  narrowestMode,
  parseToolClass,
  type AgentProfile,
  type AppManifest,
  type FadenClient,
  type ToolDefinition,
  type ToolMode,
} from "@fadenstack/client";

import { AgentBuilder, type AgentSettings } from "./builder.js";
import { EventReporter } from "./reporter.js";
import { AgentSession } from "./session.js";
import type { AgentContext } from "./stages.js";
import { toDefinition, withToolClass, type AgentTool } from "./tools.js";
import { newId, type SessionInfo } from "./transcript.js";

/**
 * An agent served by a Fadenstack server and run on this device: its profile, its tools, and its sessions.
 * The loop runs here (01-design §5); every model call goes through the gateway. .NET: `Faden.Agents.FadenAgent`.
 */
export class FadenAgent {
  readonly settings: AgentSettings;
  readonly reporter: EventReporter;
  #profile: AgentProfile | undefined;
  #tools: readonly AgentTool[] = [];
  #starting: Promise<void> | undefined;

  constructor(settings: AgentSettings) {
    this.settings = settings;
    this.reporter = new EventReporter(settings.client, settings.report);
  }

  static createBuilder(): AgentBuilder {
    return new AgentBuilder();
  }

  get slug(): string {
    return this.settings.agent;
  }

  get client(): FadenClient {
    return this.settings.client;
  }

  /** The agent's profile, once `start` ran. */
  get profile(): AgentProfile {
    if (!this.#profile) throw new Error("Call start() first.");
    return this.#profile;
  }

  get isStarted(): boolean {
    return this.#profile !== undefined;
  }

  /** The tools the agent runs, with their effective classes, once started. */
  get tools(): readonly AgentTool[] {
    return this.#tools;
  }

  /** The most any session may use: the profile's ceiling (EE), or `auto`. */
  get ceiling(): ToolMode {
    return this.#profile?.toolModes.ceiling ?? "auto";
  }

  /** The mode new sessions start in: `ask`, or stricter. */
  get defaultToolMode(): ToolMode {
    return narrowestMode(narrowestMode(this.settings.defaultMode, this.#profile?.toolModes.default ?? "ask"), this.ceiling);
  }

  /**
   * Loads the profile, checks the modules the agent requires, and settles the tools: host tools outside the
   * agent's contract are dropped, the others get the stricter of their own class and the contract's.
   */
  start(signal?: AbortSignal): Promise<void> {
    if (this.#profile) return Promise.resolve();
    this.#starting ??= this.#start(signal).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /** Loads the profile again (after a new version was published) and settles the tools anew. */
  async restart(signal?: AbortSignal): Promise<void> {
    this.#profile = undefined;
    await this.start(signal);
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const profile = await this.client.agent!.getProfile(signal);
    const missing = profile.requiredClientModules.filter((m) => !this.settings.modules.includes(m));
    if (missing.length) {
      throw new FadenError(`The agent '${this.slug}' needs the module(s) ${missing.join(", ")}; add them to the builder.`);
    }
    const contract = new Map(profile.hostToolContract.map((t) => [t.name, t]));
    const tools: AgentTool[] = [];
    for (const tool of this.settings.tools) {
      const entry = contract.get(tool.name);
      if (contract.size > 0 && !entry) continue; // the gateway refuses it anyway; not offering it keeps the model from trying
      const toolClass = effectiveToolClass(tool.toolClass, entry ? parseToolClass(entry.risk) : undefined);
      tools.push(toolClass === tool.toolClass ? tool : withToolClass(tool, toolClass));
    }
    const context: AgentContext = {
      client: this.client,
      profile,
      report: (event) => this.reporter.reportNow([event]),
    };
    for (const source of this.settings.sources) {
      for (const tool of await source.getTools(context, signal)) {
        if (!tools.some((t) => t.name === tool.name)) tools.push(tool); // a host tool wins over a source's of the same name
      }
    }
    this.#tools = tools;
    this.#profile = profile;
    if (this.settings.report) void this.#reportManifest();
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
    const session = new AgentSession(this, newId(), [], toolMode ?? this.defaultToolMode);
    await session.writeStart();
    return session;
  }

  /** A session from this device's store, to go on with in its last mode. */
  async openSession(sessionId: string): Promise<AgentSession> {
    await this.start();
    const entries = await this.settings.sessions.read(this.slug, sessionId);
    if (entries.length === 0) throw new Error(`No session '${sessionId}' for '${this.slug}' on this device.`);
    return new AgentSession(this, sessionId, entries, AgentSession.lastMode(entries) ?? this.defaultToolMode);
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.settings.sessions.list(this.slug);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.settings.sessions.delete(this.slug, sessionId);
  }

  /** Sends what is left to report. */
  flush(): Promise<void> {
    return this.reporter.flush();
  }

  async dispose(): Promise<void> {
    await this.flush();
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
