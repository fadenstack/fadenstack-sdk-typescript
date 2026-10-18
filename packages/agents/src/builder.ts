import {
  FadenstackClient,
  narrowestMode,
  type ChatStreamer,
  type FadenstackClientOptions,
  type ManifestContext,
  type ReasoningEffort,
  type TokenProvider,
  type ToolMode,
} from "@fadenstack/client";

import { FadenstackAgent } from "./agent.js";
import {
  approvalsFrom,
  denyAllApprovals,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  type PermissionMode,
} from "./approvals.js";
import { IndexedDbApprovalStore, MemoryApprovalStore, type ApprovalStore } from "./approvalStore.js";
import { IndexedDbSessionStore } from "./indexedDbSessionStore.js";
import { MemorySessionStore, type SessionStore } from "./sessionStore.js";
import type { ChatStage, FadenstackModule, ToolSource, ToolStage } from "./stages.js";
import type { AgentTool } from "./tools.js";

/** What an agent was built with. */
export interface AgentSettings {
  readonly client: FadenstackClient;
  readonly agent: string;
  /** The gateway's chat, wrapped in the chat stages. */
  readonly chat: ChatStreamer;
  readonly tools: readonly AgentTool[];
  readonly sources: readonly ToolSource[];
  readonly toolStages: readonly ToolStage[];
  readonly modules: readonly string[];
  readonly approvals: ApprovalHandler;
  readonly sessions: SessionStore;
  /** Where "Allow always" is kept. */
  readonly approvalStore: ApprovalStore;
  readonly permissionMode: PermissionMode;
  readonly defaultMode: ToolMode;
  readonly maxRounds: number;
  readonly historyTokens: number;
  readonly report: boolean;
  readonly reasoning: ReasoningEffort | undefined;
  /** The app the agent runs in, for the manifest it reports when it starts. */
  readonly app: AppDescription;
}

/** The app's name when the host did not describe it (`describeApp`). */
export const UNDESCRIBED_APP_NAME = "Fadenstack SDK app";

/** The app an agent runs in: what its manifest says besides the tools. */
export interface AppDescription {
  /** "Chrome extension", "Word add-in". */
  name: string;
  version?: string;
  /** What the app offers the agent to read, by id. */
  context?: ManifestContext[];
  /** The greeting and suggestions the app would show. */
  ui?: { greeting?: string; suggestions?: string[] };
}

/**
 * Puts an agent together: the server, the agent, its host tools, who approves, where sessions live, and the
 * modules. `FadenstackAgent.createBuilder().useClient(client).useAgent("browser-assistant").addTools(...tools).build()`.
 */
export class AgentBuilder {
  readonly #tools: AgentTool[] = [];
  readonly #sources: ToolSource[] = [];
  readonly #chatStages: { order: number; wrap: ChatStage }[] = [];
  readonly #toolStages: { order: number; stage: ToolStage }[] = [];
  readonly #modules: string[] = [];
  #client: FadenstackClient | undefined;
  #options: FadenstackClientOptions | undefined;
  #agent: string | undefined;
  #approvals: ApprovalHandler = denyAllApprovals;
  #sessions: SessionStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #permissionMode: PermissionMode = "ask";
  #defaultMode: ToolMode = "ask";
  #maxRounds = 16;
  #historyTokens = 24_000;
  #report = true;
  #reasoning: ReasoningEffort | undefined;
  #app: AppDescription = { name: UNDESCRIBED_APP_NAME };

  /** The server, and how the agent signs in (usually an `AgentTokenProvider`). */
  useServer(serverUrl: string | URL, credentials: TokenProvider, options: Omit<FadenstackClientOptions, "serverUrl" | "credentials"> = {}): this {
    this.#options = { ...options, serverUrl, credentials };
    this.#client = undefined;
    return this;
  }

  /** A client made elsewhere; it must be for the agent's route (`agent` in its options). */
  useClient(client: FadenstackClient): this {
    this.#client = client;
    this.#agent ??= client.options.agent;
    this.#options = undefined;
    return this;
  }

  useAgent(agent: string): this {
    if (!agent?.trim()) throw new TypeError("An agent slug is required.");
    this.#agent = agent;
    return this;
  }

  /** Host tools (see `defineTool`). */
  addTools(...tools: AgentTool[]): this {
    this.#tools.push(...tools);
    return this;
  }

  addToolSource(source: ToolSource): this {
    this.#sources.push(source);
    return this;
  }

  /** Who asks the user. Without one every call that needs approval is declined. */
  useApprovals(handler: ApprovalHandler | ((request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>)): this {
    this.#approvals = typeof handler === "function" ? approvalsFrom(handler) : handler;
    return this;
  }

  /** Where sessions live; by default IndexedDB in a browser, memory elsewhere. */
  useSessionStore(store: SessionStore): this {
    this.#sessions = store;
    return this;
  }

  /** Where "Allow always" is kept; by default IndexedDB in a browser, memory elsewhere. */
  useApprovalStore(store: ApprovalStore): this {
    this.#approvalStore = store;
    return this;
  }

  /**
   * `ask` (the default): calls the tool mode asks about wait for the user. `bypass`: they are approved without
   * asking, destructive ones too -- for development and trusted automation, never a user's choice. An admin's
   * "Ask first" rule still asks, and the transcript and the server's record say `bypass` for each call it let
   * through. The agent warns once when it starts in bypass.
   */
  usePermissionMode(mode: PermissionMode): this {
    if (mode !== "ask" && mode !== "bypass") throw new TypeError(`A permission mode is ask or bypass, not '${String(mode)}'.`);
    this.#permissionMode = mode;
    return this;
  }

  /**
   * The mode new sessions start in. It can only be stricter than `ask`: every session starts asking unless the
   * user widens that session.
   */
  useDefaultToolMode(mode: ToolMode): this {
    this.#defaultMode = narrowestMode("ask", mode);
    return this;
  }

  /** Model calls per turn before the loop stops (default 16). */
  useMaxRounds(rounds: number): this {
    if (!(rounds >= 1)) throw new RangeError("At least one round.");
    this.#maxRounds = rounds;
    return this;
  }

  /** About how many tokens of history a request carries (default 24 000); older turns are left out. */
  useHistoryBudget(tokens: number): this {
    if (!(tokens >= 1)) throw new RangeError("A positive budget.");
    this.#historyTokens = tokens;
    return this;
  }

  /**
   * How much the model reasons before it answers, on every request (default: the model's own). `none` asks for
   * no reasoning: a reasoning model answers at once. Models without a setting ignore it.
   */
  useReasoning(effort: ReasoningEffort): this {
    this.#reasoning = effort;
    return this;
  }

  /**
   * Whether tool runs and approvals (names and counts only), and the app's manifest, are reported to the server.
   * Default on.
   */
  useEventReporting(enabled: boolean): this {
    this.#report = enabled;
    return this;
  }

  /**
   * The app the agent runs in. When the agent starts it tells the server what the app brings -- its host tools
   * with their classes, this context and greeting, the versions -- so the server's admins take new tools in with
   * a click instead of typing them; until they do, the server holds them back. (An agent with no contract at all
   * holds nothing back: every tool is unclassified then, and asks every time.)
   */
  describeApp(app: AppDescription): this {
    if (!app.name?.trim()) throw new TypeError("An app needs a name.");
    this.#app = app;
    return this;
  }

  /** A stage around the chat at `order` (`StageOrder`). */
  addChatStage(order: number, wrap: ChatStage): this {
    this.#chatStages.push({ order, wrap });
    return this;
  }

  /** A stage around each tool call at `order` (`StageOrder`). */
  addToolStage(order: number, stage: ToolStage): this {
    this.#toolStages.push({ order, stage });
    return this;
  }

  use(module: FadenstackModule): this {
    if (module.name) this.#modules.push(module.name);
    module.configure(this);
    return this;
  }

  build(): FadenstackAgent {
    const agent = this.#agent;
    if (!agent) throw new Error("Call useAgent(slug).");
    let client = this.#client;
    if (!client) {
      if (!this.#options) throw new Error("Call useServer(...) or useClient(...).");
      client = new FadenstackClient({ ...this.#options, agent });
    } else if (client.options.agent !== agent) {
      throw new Error(`The client is for '${client.options.agent ?? "(no agent)"}', not '${agent}': one agent per client.`);
    }
    const names = new Set<string>();
    for (const tool of this.#tools) {
      if (names.has(tool.name)) throw new Error(`Two tools are named '${tool.name}'.`);
      names.add(tool.name);
    }
    // Lower order is further from the transport: wrap from the transport outwards.
    let chat: ChatStreamer = client.chat;
    for (const stage of [...this.#chatStages].sort((a, b) => b.order - a.order)) chat = stage.wrap(chat);
    return FadenstackAgent.create({
      client,
      agent,
      chat,
      tools: [...this.#tools],
      sources: [...this.#sources],
      toolStages: [...this.#toolStages].sort((a, b) => a.order - b.order).map((s) => s.stage),
      modules: [...this.#modules],
      approvals: this.#approvals,
      sessions: this.#sessions ?? (globalThis.indexedDB ? new IndexedDbSessionStore() : new MemorySessionStore()),
      approvalStore: this.#approvalStore ?? (globalThis.indexedDB ? new IndexedDbApprovalStore() : new MemoryApprovalStore()),
      permissionMode: this.#permissionMode,
      defaultMode: this.#defaultMode,
      maxRounds: this.#maxRounds,
      historyTokens: this.#historyTokens,
      report: this.#report,
      reasoning: this.#reasoning,
      app: this.#app,
    });
  }
}
