import {
  DirectChatClient,
  FadenstackClient,
  type ChatStreamer,
  type EndpointReport,
  type FadenstackClientOptions,
  type ModelEndpoint,
  type ManifestContext,
  type ReasoningEffort,
  type TokenProvider,
  type ToolMode,
} from "@fadenstack/client";

import { FadenstackAgent } from "./agent.js";
import { ServerBackend, type AgentBackend } from "./backend.js";
import type { AgentDefinition } from "./definition.js";
import { AgentLog } from "./log.js";
import { LocalBackend, type LocalProfileOptions } from "./localBackend.js";
import { MachinePolicy, MachinePolicyError, PolicyAccess } from "./machinePolicy.js";
import {
  approvalsFrom,
  denyAllApprovals,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  type PermissionMode,
} from "./approvals.js";
import type { ApprovalStore } from "./approvalStore.js";
import type { SecretProtector } from "./secretProtection.js";
import type { StoreProblemHandler } from "./storeSupport.js";
import type { SessionRetention, SessionStore } from "./sessionStore.js";
import { isStepUpHandler, type StepUpHandler } from "./stepUp.js";
import type { ChatStage, FadenstackModule, ToolServiceFactory, ToolSource, ToolStage } from "./stages.js";
import { refuseReservedToolNames, type AgentTool, type ToolServiceKey } from "./tools.js";
import type { GrantHandler, GrantPlaceResolver } from "./grants.js";
import type { ReasoningStore } from "./reasoning.js";
import { writeLog, type FadenstackLogger } from "@fadenstack/client";

/** What an agent was built with. */
export interface AgentSettings {
  /** What the agent talks to: the server (`ServerBackend`, which holds the client) or the person's endpoint (`LocalBackend`). */
  readonly backend: AgentBackend;
  readonly agent: string;
  /** The backend's chat (the gateway's, or the person's endpoint), wrapped in the chat stages. */
  readonly chat: ChatStreamer;
  /**
   * A standalone agent's instructions, its definition's then the person's own (D7); undefined with a server, whose gateway adds
   * the agent's own. The session sets them on every model call, above the chat stages (`ChatOptions.instructions`).
   */
  readonly instructions?: string;
  /** What IT set for this machine (`useMachinePolicy`); `MachinePolicy.none` when the app gave none. */
  readonly machinePolicy?: MachinePolicy;
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
  /** The app's limits for the sessions the SDK keeps (default 50 sessions, 90 days); the server's can only lower them. */
  readonly sessionRetention?: SessionRetention;
  /** What encrypts the stores the SDK keeps; undefined: a WebCrypto key per signed-in user in a browser, none elsewhere. */
  readonly secretProtector?: SecretProtector;
  /** Told of a stored record that does not decrypt (never its contents); undefined: nobody. */
  readonly onStoreProblem?: StoreProblemHandler;
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

/** The name `@fadenstack/provenance` gives its module (its `PROVENANCE_MODULE`); this package cannot import that package. */
const PROVENANCE_MODULE_NAME = "provenance";

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
  #endpoint: ModelEndpoint | undefined;
  #endpointReport: EndpointReport | undefined;
  #streamer: ChatStreamer | undefined;
  #definition: AgentDefinition | undefined;
  #ownInstructions: string | undefined;
  #localOptions: LocalProfileOptions | undefined;
  #policy: MachinePolicy = MachinePolicy.none;
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
  #sessionRetention: SessionRetention | undefined;
  #secretProtector: SecretProtector | undefined;
  #onStoreProblem: StoreProblemHandler | undefined;

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

  /**
   * Standalone mode (sdk/51 F03): the person's own OpenAI-compatible endpoint, with no Fadenstack server. Needs
   * `useLocalProfile`; never together with `useServer` or `useClient`. The endpoint check's `report`, if the app kept one,
   * says whether the model sees pictures. .NET: `UseEndpoint`.
   */
  useEndpoint(endpoint: ModelEndpoint, report?: EndpointReport): this {
    if (!endpoint) throw new TypeError("An endpoint is required.");
    this.#endpoint = endpoint;
    this.#endpointReport = report;
    return this;
  }

  /**
   * Standalone mode with any `ChatStreamer` as the model, instead of `useEndpoint`: the host's own (a provider's SDK behind
   * it, a test's), which stays the host's -- the agent never closes it. Its answers count as `external` for the model's
   * residency. Needs `useLocalProfile`. .NET: `UseChatClient`.
   */
  useChatStreamer(streamer: ChatStreamer): this {
    if (typeof streamer?.stream !== "function") throw new TypeError("A chat streamer has a stream(messages, options) method.");
    this.#streamer = streamer;
    return this;
  }

  /**
   * What IT set for this machine (sdk/51 F09): `build()` refuses an endpoint the policy forbids or does not list, takes away
   * the plain-http opt-in where it forbids plain http, and narrows local MCP and skills, with a server too. The app reads the
   * policy from its managed location (Chrome: `MachinePolicy.from(await chrome.storage.managed.get())`) and locks what it
   * sets. .NET: `UseMachinePolicy`.
   */
  useMachinePolicy(policy: MachinePolicy): this {
    if (!(policy instanceof MachinePolicy)) throw new TypeError("A MachinePolicy is needed: MachinePolicy.from(object), MachinePolicy.fromJson(text) or MachinePolicy.none.");
    this.#policy = policy;
    return this;
  }

  /**
   * The agent's definition for standalone mode (the app's own `contracts/*.json`): its slug, instructions, host tool contract
   * and greeting. The person's own instructions, if any, come after the definition's (D7). The person's settings (`options`)
   * say whether local MCP servers and skills are on. .NET: `UseLocalProfile`.
   */
  useLocalProfile(definition: AgentDefinition, ownInstructions?: string, options?: LocalProfileOptions): this {
    if (!definition) throw new TypeError("A definition is required.");
    this.#definition = definition;
    this.#ownInstructions = ownInstructions;
    this.#localOptions = options;
    return this;
  }

  useAgent(agent: string): this {
    if (!agent?.trim()) throw new TypeError("An agent slug is required.");
    this.#agent = agent;
    return this;
  }

  /** Host tools (see `defineTool`). A name the SDK keeps for its own tools (`RESERVED_TOOL_NAMES`) is refused. */
  addTools(...tools: AgentTool[]): this {
    refuseReservedToolNames(tools);
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
    const standalone = this.#endpoint !== undefined || this.#streamer !== undefined;
    if (standalone && (this.#client || this.#options)) {
      throw new Error("An agent talks to a Fadenstack server (useServer, useClient) or to an endpoint (useEndpoint, useChatStreamer), never both.");
    }
    let backend: AgentBackend;
    let server: ServerBackend | undefined;
    let agent: string;
    let instructions: string | undefined;
    if (standalone) {
      if (this.#endpoint && this.#streamer) throw new Error("Give the agent one model: useEndpoint or useChatStreamer, not both.");
      const definition = this.#definition;
      if (!definition) throw new Error("An agent on an endpoint needs its definition: call useLocalProfile(AgentDefinition.fromJson(...)).");
      if (this.#agent !== undefined && this.#agent !== definition.slug) {
        throw new Error(`The definition is for '${definition.slug}', not '${this.#agent}': in standalone mode the slug comes from the definition.`);
      }
      agent = definition.slug;
      const policy = this.#policy;
      if (policy.standalone !== PolicyAccess.Allowed) {
        throw new MachinePolicyError("standalone",
          "This computer's policy does not allow an agent on its own model endpoint: connect to the organisation's server.");
      }
      if (this.#endpoint && !policy.allowsEndpoint(this.#endpoint.baseUrl)) {
        throw new MachinePolicyError("endpoints", "This computer's policy does not list this endpoint.");
      }
      if (this.#streamer && policy.endpoints !== null) {
        throw new MachinePolicyError("endpoints", "This computer's policy allows only listed endpoints, and a host's own chat client names none.");
      }
      this.#assertNoDuplicateTools();
      // The builder's logger is the endpoint's unless it has its own.
      let endpoint = this.#endpoint && this.#logger && !this.#endpoint.logger ? { ...this.#endpoint, logger: this.#logger } : this.#endpoint;
      // Plain http forbidden: the person's opt-in is taken away, and the transport says why (loopback stays).
      if (endpoint && policy.plainHttp !== PolicyAccess.Allowed) endpoint = { ...endpoint, allowPlainHttpInLan: false, plainHttpForbidden: true };
      // What the person turned on, under the policy: never more.
      const local: LocalProfileOptions = {
        ...this.#localOptions,
        localMcp: this.#localOptions?.localMcp === true && policy.mcp.allowsAny,
        localSkills: this.#localOptions?.localSkills !== false && policy.skills.allowsAny,
      };
      // An endpoint's client is made here; a host's own streamer stays the host's.
      backend = new LocalBackend({ definition, chat: this.#streamer ?? new DirectChatClient(endpoint!), endpoint,
        report: this.#endpointReport, options: local });
      // Marking by default as far as the layering allows (sdk/51 F10, owner, 14 Nov): this package cannot load the provenance
      // module, so it says so once, here, when a standalone agent goes without it.
      if (!this.#modules.includes(PROVENANCE_MODULE_NAME)) writeLog(this.#logger, AgentLog.noProvenanceModule, { Agent: agent });
      // D7: the person's own instructions come after the definition's.
      instructions = [definition.instructions, this.#ownInstructions?.trim()].filter((part) => part).join("\n\n") || undefined;
    } else {
      if (this.#definition) throw new Error("useLocalProfile is for an agent on an endpoint: with a server the agent's definition is the server's.");
      const named = this.#agent;
      if (!named) throw new Error("Call useAgent(slug).");
      agent = named;
      let client = this.#client;
      if (!client) {
        if (!this.#options) throw new Error("Call useServer(...) or useClient(...).");
        client = new FadenstackClient({ ...this.#options, agent });
      } else if (client.options.agent !== agent) {
        throw new Error(`The client is for '${client.options.agent ?? "(no agent)"}', not '${agent}': one agent per client.`);
      }
      this.#assertNoDuplicateTools();
      backend = server = new ServerBackend(client);
    }
    // Lower order is further from the transport: wrap from the transport outwards.
    let chat: ChatStreamer = backend.chat; // the model, under the chat stages
    for (const stage of [...this.#chatStages].sort((a, b) => b.order - a.order)) chat = stage.wrap(chat);
    // The server offers Bypass only to a client that names the whole flow, so it is named only where the app can open the
    // second sign-in. (The backend does it to the client, a host's own included, as the builder always did.)
    server?.applyTransportRules({
      logger: this.#logger,
      announcesBypass: !!(this.#stepUp ?? (isStepUpHandler(this.#approvals) ? this.#approvals : undefined)),
    });
    return FadenstackAgent.create({
      backend,
      agent,
      chat,
      ...(instructions ? { instructions } : {}),
      machinePolicy: this.#policy,
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
      ...(this.#sessionRetention ? { sessionRetention: this.#sessionRetention } : {}),
      ...(this.#secretProtector ? { secretProtector: this.#secretProtector } : {}),
      ...(this.#onStoreProblem ? { onStoreProblem: this.#onStoreProblem } : {}),
    });
  }

  #assertNoDuplicateTools(): void {
    const names = new Set<string>();
    for (const tool of this.#tools) {
      if (names.has(tool.name)) throw new Error(`Two tools are named '${tool.name}'.`);
      names.add(tool.name);
    }
  }

  /**
   * How many sessions, and how old, the default session store keeps (default 50 and 90 days). If the server sets limits too
   * (`local_retention` in the profile), the stricter of each applies; a limit the server leaves out stays. .NET:
   * `AgentBuilder.UseSessionRetention`.
   */
  useSessionRetention(retention: SessionRetention): this {
    if (!Number.isInteger(retention.maxSessions) || !Number.isInteger(retention.maxAgeDays) || retention.maxSessions < 1 || retention.maxAgeDays < 1) {
      throw new RangeError("Retention needs at least one session and one day.");
    }
    this.#sessionRetention = { ...retention };
    return this;
  }

  /**
   * What encrypts the sessions and "Allow always" the SDK keeps in IndexedDB. By default a non-extractable WebCrypto key per
   * signed-in user, in a database of its own, in a browser; where there is no IndexedDB (Node) the SDK keeps nothing and
   * writes no key. A host with its own key store passes a protector over it here. Data one protector wrote another cannot read.
   */
  useSecretProtector(protector: SecretProtector): this {
    this.#secretProtector = protector;
    return this;
  }

  /** Called when a stored record does not decrypt or cannot be read: the record is treated as absent. Gets no contents. */
  useStoreProblemHandler(handler: StoreProblemHandler): this {
    this.#onStoreProblem = handler;
    return this;
  }
}
