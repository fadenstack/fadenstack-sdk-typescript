import {
  BYPASS_SUPPORTS,
  FadenstackClient,
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
import type { ApprovalStore } from "./approvalStore.js";
import type { SessionStore } from "./sessionStore.js";
import { isStepUpHandler, type StepUpHandler } from "./stepUp.js";
import type { ChatStage, FadenstackModule, ToolServiceFactory, ToolSource, ToolStage } from "./stages.js";
import type { AgentTool, ToolServiceKey } from "./tools.js";
import type { GrantHandler, GrantPlaceResolver } from "./grants.js";
import type { ReasoningStore } from "./reasoning.js";
import type { FadenstackLogger } from "@fadenstack/client";

/** What an agent was built with. */
export interface AgentSettings {
  readonly client: FadenstackClient;
  readonly agent: string;
  /** The gateway's chat, wrapped in the chat stages. */
  readonly chat: ChatStreamer;
  readonly tools: readonly AgentTool[];
  readonly sources: readonly ToolSource[];
  readonly toolStages: readonly ToolStage[];
  /** What modules give tools per call, by key. */
  readonly toolServices: ReadonlyMap<ToolServiceKey<unknown>, ToolServiceFactory<unknown>>;
  readonly modules: readonly string[];
  readonly approvals: ApprovalHandler;
  /** The host's own session store; undefined: the SDK keeps them in the signed-in user's own database (`FadenstackAgent.sessionStore`). */
  readonly sessions?: SessionStore;
  /** The host's own store for "Allow always"; undefined: the SDK keeps it in the signed-in user's own database. */
  readonly approvalStore?: ApprovalStore;
  /** Who opens the second sign-in for Bypass; undefined: the approval handler when it is one (`FadenstackAgent.stepUpHandler`). */
  readonly stepUp?: StepUpHandler;
  /** Who draws the grant card; undefined: the approval handler when it does (`FadenstackAgent.grantHandler`). */
  readonly grantHandler?: GrantHandler;
  readonly permissionMode: PermissionMode;
  readonly requireHostToolPolicyChecks: boolean;
  readonly grantPlaceResolver?: GrantPlaceResolver;
  /** The app's cap on the server's default level; undefined: none. */
  readonly defaultMode?: ToolMode;
  readonly maxRounds: number;
  readonly historyTokens: number;
  readonly report: boolean;
  readonly reasoning: ReasoningEffort | undefined;
  /** The host's own store for the person's thinking level; undefined: the browser's IndexedDB, per signed-in user. */
  readonly reasoningStore?: ReasoningStore;
  /** Where the agent and its sessions log; undefined: nowhere. */
  readonly logger?: FadenstackLogger;
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
  readonly #toolServices = new Map<ToolServiceKey<unknown>, ToolServiceFactory<unknown>>();
  readonly #modules: string[] = [];
  #client: FadenstackClient | undefined;
  #options: FadenstackClientOptions | undefined;
  #agent: string | undefined;
  #approvals: ApprovalHandler = denyAllApprovals;
  #sessions: SessionStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #stepUp: StepUpHandler | undefined;
  #grantHandler: GrantHandler | undefined;
  #permissionMode: PermissionMode = "ask";
  #requireHostToolPolicyChecks = false;
  #grantPlaceResolver: GrantPlaceResolver | undefined;
  #defaultMode: ToolMode | undefined;
  #maxRounds = 16;
  #historyTokens = 24_000;
  #report = true;
  #reasoning: ReasoningEffort | undefined;
  #reasoningStore: ReasoningStore | undefined;
  #logger: FadenstackLogger | undefined;
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

  /**
   * Where sessions live. By default the signed-in user's own IndexedDB database in a browser (memory elsewhere), so two
   * people in one browser profile never see each other's; a store passed here is used as it is and is the host's to keep apart.
   */
  useSessionStore(store: SessionStore): this {
    this.#sessions = store;
    return this;
  }

  /** Where "Allow always" is kept; by default the signed-in user's own IndexedDB database in a browser, memory elsewhere. */
  useApprovalStore(store: ApprovalStore): this {
    this.#approvalStore = store;
    return this;
  }

  /**
   * `ask` (the default): calls the tool mode asks about wait for the user. `bypass`: the app's code asks for the
   * server's Bypass, with no card but through the same grant: the person signs in a second time in the browser
   * (`useStepUpHandler`) and the server makes the grant; where the server does not offer Bypass, or the app opens no
   * second sign-in, its sessions run in `auto` instead of `ask`. An admin's "Ask first" rule and a tool that asks every
   * time still ask, and so do the gateway's own questions. The agent warns once when it starts without the flow.
   */
  usePermissionMode(mode: PermissionMode): this {
    if (mode !== "ask" && mode !== "bypass") throw new TypeError(`A permission mode is ask or bypass, not '${String(mode)}'.`);
    this.#permissionMode = mode;
    return this;
  }

  /**
   * Who opens the second sign-in the server's Bypass needs (sdk/41): it opens the verification page in the system browser or
   * a new window -- never an iframe of the app's page -- and shows that it waits (`browserStepUp()` does it in a browser). An
   * approval handler that is one (`open` and `report`) is used when none is given. Without one there is no Bypass, and the
   * agent announces none (`X-Faden-Client-Supports`): the server then offers none.
   */
  useStepUpHandler(handler: StepUpHandler): this {
    if (!isStepUpHandler(handler)) throw new TypeError("A step-up handler has open() and report().");
    this.#stepUp = handler;
    return this;
  }

  /**
   * Who draws the grant card (the Bypass confirmation, the work card): `requestGrant(offer, signal)`. An approval handler
   * that has it is used when none is given. Without one, no grant card is offered.
   */
  useGrantHandler(handler: GrantHandler): this {
    this.#grantHandler = handler;
    return this;
  }

  /** Require fresh central host dispatch checks; never fall back to cached policy on an older gateway. */
  requireHostToolPolicyChecks(): this {
    this.#requireHostToolPolicyChecks = true;
    return this;
  }

  /** A work grant never replaces native resolution, scope or access checks. */
  useGrantPlaceResolver(resolver: GrantPlaceResolver): this { this.#grantPlaceResolver = resolver; return this; }

  /**
   * A cap on the mode new sessions start in. Sessions start in the agent's default level from the server (`ask`
   * unless its author set another); this can only narrow it, never widen it -- for an app that never starts in
   * `auto`, say.
   */
  useDefaultToolMode(mode: ToolMode): this {
    this.#defaultMode = mode;
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
   * Where the agent logs: profile, tools, each turn, tool and approval, as names, ids, counts, durations and outcomes -- never a
   * prompt, an answer, reasoning, attachment text, tool arguments or results, a token or who the user is. The same events and
   * fields as the .NET SDK's. The client gets the logger too unless it has one (its requests: method, route, status, time).
   * Nowhere by default; there is no file sink in a browser.
   */
  useLogging(logger: FadenstackLogger): this {
    if (typeof logger?.log !== "function") throw new TypeError("A logger has a log(event) method.");
    this.#logger = logger;
    return this;
  }

  /**
   * Where the level of thinking a person picked is kept, per person and agent (`FadenstackAgent.setReasoning`). By default
   * the signed-in user's own IndexedDB database in a browser -- unless the host keeps both the sessions and the approvals
   * itself, which leaves the pick in memory for the run.
   */
  useReasoningStore(store: ReasoningStore): this {
    this.#reasoningStore = store;
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

  /**
   * A service tools get per call (`context.services.get(key)`), made by `factory` on the call's first use. One
   * factory per key: a second throws.
   */
  addToolService<T>(key: ToolServiceKey<T>, factory: ToolServiceFactory<T>): this {
    if (this.#toolServices.has(key)) throw new Error(`The tool service '${key.name}' is already added.`);
    this.#toolServices.set(key, factory as ToolServiceFactory<unknown>);
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
    // The server offers Bypass only to a client that names the whole flow, so it is named only where the app can open the
    // second sign-in.
    if (this.#logger) client.transport.useLogger(this.#logger);
    if (this.#stepUp ?? (isStepUpHandler(this.#approvals) ? this.#approvals : undefined)) client.transport.announce(...BYPASS_SUPPORTS);
    return FadenstackAgent.create({
      client,
      agent,
      chat,
      tools: [...this.#tools],
      sources: [...this.#sources],
      toolStages: [...this.#toolStages].sort((a, b) => a.order - b.order).map((s) => s.stage),
      toolServices: new Map(this.#toolServices),
      modules: [...this.#modules],
      approvals: this.#approvals,
      ...(this.#sessions ? { sessions: this.#sessions } : {}),
      ...(this.#approvalStore ? { approvalStore: this.#approvalStore } : {}),
      ...(this.#stepUp ? { stepUp: this.#stepUp } : {}),
      ...(this.#grantHandler ? { grantHandler: this.#grantHandler } : {}),
      permissionMode: this.#permissionMode,
      requireHostToolPolicyChecks: this.#requireHostToolPolicyChecks,
      ...(this.#grantPlaceResolver ? { grantPlaceResolver: this.#grantPlaceResolver } : {}),
      ...(this.#defaultMode ? { defaultMode: this.#defaultMode } : {}),
      maxRounds: this.#maxRounds,
      historyTokens: this.#historyTokens,
      report: this.#report,
      reasoning: this.#reasoning,
      ...(this.#reasoningStore ? { reasoningStore: this.#reasoningStore } : {}),
      ...(this.#logger ? { logger: this.#logger } : {}),
      app: this.#app,
    });
  }
}
