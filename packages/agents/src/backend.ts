import type {
  AgentClientEvent,
  AgentGrant,
  AgentProfile,
  AgentToolInfo,
  AnswerScope,
  AppManifest,
  ChatStreamer,
  FadenstackClient,
  FadenstackLogger,
  GrantExtension,
  GrantList,
  GrantReport,
  GrantRequest,
  HostToolCheck,
  HostToolDecision,
  SkillList,
  StepUpPoll,
  StepUpStarted,
} from "@fadenstack/client";
import { BYPASS_SUPPORTS } from "@fadenstack/client";

/**
 * How an agent is connected (`FadenstackAgent.connection`): to an organisation's Fadenstack server, or to the person's own
 * model endpoint. Apps and the UI read it to show or hide the server's parts; nothing decides security by it.
 * .NET: `AgentConnection`.
 */
export type AgentConnection = "governed" | "standalone";

/** Where the agent's profile comes from. */
export interface ProfileSource {
  getProfile(signal?: AbortSignal): Promise<AgentProfile>;
}

/** Where the agent tells what happened on the device (events) and what the app brings (the manifest). */
export interface EventSink {
  /** Whether events go anywhere at all. */
  readonly acceptsEvents: boolean;
  report(events: readonly AgentClientEvent[], signal?: AbortSignal): Promise<void>;
  reportManifest(manifest: AppManifest, signal?: AbortSignal): Promise<{ sha256: string; isNew: boolean }>;
}

/** Where the user's own settings are kept (the language they picked). */
export interface UserSettings {
  setUserLanguage(language: string | null, signal?: AbortSignal): Promise<string | null>;
}

/** The skills the organisation's server offers. */
export interface ServerSkills {
  listSkills(options: { query?: string; limit?: number; signal?: AbortSignal }): Promise<SkillList>;
}

/** The tools of the organisation's MCP servers the server lists for the user and the agent. */
export interface ServerTools {
  /** The list; null when the server does not list them (an older one). */
  listTools(signal?: AbortSignal): Promise<AgentToolInfo[] | null>;
}

/** Answers a tool approval the gateway holds. */
export interface GatewayApprovals {
  answerApproval(approvalId: string, approved: boolean, scope: AnswerScope, signal?: AbortSignal): Promise<void>;
}

/** The central policy for a host tool call: prepare, then check again at dispatch. */
export interface HostToolChecks {
  checkHostTool(check: HostToolCheck, signal?: AbortSignal): Promise<HostToolDecision>;
}

/** The grants (a stretch of work, a time, Bypass) the server keeps. */
export interface GrantService {
  createGrant(request: GrantRequest, options?: { conversationId?: string; stepUpProof?: string; signal?: AbortSignal }): Promise<AgentGrant>;
  reportGrant(id: string, calls: readonly string[], signal?: AbortSignal): Promise<GrantReport>;
  getGrant(id: string, signal?: AbortSignal): Promise<AgentGrant>;
  extendGrant(id: string, extension: GrantExtension, signal?: AbortSignal): Promise<AgentGrant>;
  revokeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant>;
  pauseGrant(id: string, signal?: AbortSignal): Promise<AgentGrant>;
  resumeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant>;
  listGrants(signal?: AbortSignal): Promise<GrantList>;
}

/** The second sign-in Bypass needs (sdk/41). */
export interface StepUp {
  startStepUp(longestMinutes?: number, clientVersion?: string, signal?: AbortSignal): Promise<StepUpStarted>;
  pollStepUp(stepUpCode: string, signal?: AbortSignal): Promise<StepUpPoll>;
}

/**
 * What the agent talks to, behind one seam (sdk/51 F02, sdk/52 §8): a Fadenstack server (`ServerBackend`) or the person's own
 * model endpoint (`LocalBackend`). The agent, its sessions and the UI see the same contracts in both modes. A backend passes the
 * server's errors through unchanged: the grant lifecycle, Bypass and the step-up catch them by type. Internal: not exported
 * from the package. .NET: `IAgentBackend`.
 *
 * The provenance routes are not in it: `@fadenstack/provenance` lies above this package, and its own `ServerBackend` reads
 * `agent.client` lazily (so a standalone agent fails there, with the clear error, at its first use, not at build).
 */
export interface AgentBackend extends ProfileSource, EventSink, UserSettings, ServerSkills, ServerTools, GatewayApprovals,
  HostToolChecks, GrantService, StepUp {
  readonly connection: AgentConnection;
  /** The Fadenstack client, when there is a server; undefined otherwise. */
  readonly serverClient: FadenstackClient | undefined;
  /** The model, as a `ChatStreamer`: the base the chat stages wrap. */
  readonly chat: ChatStreamer;
}

/** What the builder tells a server's client about the app (it mutates a host-supplied client's transport; see `ServerBackend`). */
export interface ServerTransportRules {
  /** Where the client logs too, unless it has a logger. */
  readonly logger: FadenstackLogger | undefined;
  /** The app opens a second sign-in, so the client names the whole Bypass flow (`X-Faden-Client-Supports`). */
  readonly announcesBypass: boolean;
}

/** The governed backend: every call goes to the agent's routes on the Fadenstack server, as it always did. .NET: `ServerAgentBackend`. */
export class ServerBackend implements AgentBackend {
  readonly #client: FadenstackClient;

  constructor(client: FadenstackClient) {
    this.#client = client;
  }

  /**
   * What the builder has always done to the client it is given, a host's own included: the agent's logger joins the client's
   * transport (which keeps one it has), and the Bypass flow is announced only where the app can open the second sign-in --
   * the server offers Bypass only to a client that names it. Governed mode only.
   */
  applyTransportRules(rules: ServerTransportRules): void {
    if (rules.logger) this.#client.transport.useLogger(rules.logger);
    if (rules.announcesBypass) this.#client.transport.announce(...BYPASS_SUPPORTS);
  }

  get #agent() {
    return this.#client.agent!;
  }

  readonly connection: AgentConnection = "governed";

  get serverClient(): FadenstackClient {
    return this.#client;
  }

  get chat(): ChatStreamer {
    return this.#client.chat;
  }

  get acceptsEvents(): boolean {
    return this.#client.agent !== undefined;
  }

  getProfile(signal?: AbortSignal): Promise<AgentProfile> {
    return this.#agent.getProfile(signal);
  }

  report(events: readonly AgentClientEvent[], signal?: AbortSignal): Promise<void> {
    return this.#agent.report(events, signal);
  }

  reportManifest(manifest: AppManifest, signal?: AbortSignal): Promise<{ sha256: string; isNew: boolean }> {
    return this.#agent.reportManifest(manifest, signal);
  }

  setUserLanguage(language: string | null, signal?: AbortSignal): Promise<string | null> {
    return this.#agent.setUserLanguage(language, signal);
  }

  listSkills(options: { query?: string; limit?: number; signal?: AbortSignal }): Promise<SkillList> {
    return this.#agent.listSkills(options);
  }

  listTools(signal?: AbortSignal): Promise<AgentToolInfo[] | null> {
    return this.#agent.listTools(signal);
  }

  answerApproval(approvalId: string, approved: boolean, scope: AnswerScope, signal?: AbortSignal): Promise<void> {
    return this.#agent.answerApproval(approvalId, approved, scope, signal);
  }

  checkHostTool(check: HostToolCheck, signal?: AbortSignal): Promise<HostToolDecision> {
    return this.#agent.checkHostTool(check, signal);
  }

  createGrant(request: GrantRequest, options: { conversationId?: string; stepUpProof?: string; signal?: AbortSignal } = {}): Promise<AgentGrant> {
    return this.#agent.createGrant(request, options);
  }

  reportGrant(id: string, calls: readonly string[], signal?: AbortSignal): Promise<GrantReport> {
    return this.#agent.reportGrant(id, calls, signal);
  }

  getGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return this.#agent.getGrant(id, signal);
  }

  extendGrant(id: string, extension: GrantExtension, signal?: AbortSignal): Promise<AgentGrant> {
    return this.#agent.extendGrant(id, extension, signal);
  }

  revokeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return this.#agent.revokeGrant(id, signal);
  }

  pauseGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return this.#agent.pauseGrant(id, signal);
  }

  resumeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return this.#agent.resumeGrant(id, signal);
  }

  listGrants(signal?: AbortSignal): Promise<GrantList> {
    return this.#agent.listGrants(signal);
  }

  startStepUp(longestMinutes?: number, clientVersion?: string, signal?: AbortSignal): Promise<StepUpStarted> {
    return this.#agent.startStepUp(longestMinutes, clientVersion, signal);
  }

  pollStepUp(stepUpCode: string, signal?: AbortSignal): Promise<StepUpPoll> {
    return this.#agent.pollStepUp(stepUpCode, signal);
  }
}
