import { AgentTokenProvider, type AgentTokenProviderOptions, type TokenProvider, type TokenStore } from "./auth/tokens.js";
import { FadenstackChatClient, type ChatClientSettings } from "./chat/chatClient.js";
import { FadenstackTransport, type FetchLike, type TransportOptions } from "./http/transport.js";
import type { ServerFeatures } from "./models.js";
import { AgentResource } from "./resources/agent.js";
import { ProvenanceResource } from "./resources/provenance.js";
import type { FadenstackLogger } from "./logging.js";
import type { ToolMode } from "./tools/toolModes.js";

/** How a `FadenstackClient` reaches its server, and as whom. */
export interface FadenstackClientOptions {
  /** The Fadenstack server, e.g. `https://ai.example.internal`. */
  serverUrl: string | URL;
  /** The backend (sign-in, agent tokens), when it is not at `serverUrl`. */
  apiUrl?: string | URL;
  /**
   * The agent this client works for (its slug or id): chat goes to `/v1/agents/{agent}/...`. One agent per
   * client. Without one, the client uses the plain `/v1` routes with an API token.
   */
  agent?: string;
  /** Where access tokens come from: an API token, or an agent sign-in (`AgentTokenProvider`). */
  credentials?: TokenProvider;
  /** The model for the plain routes; an agent's model is the agent's, whatever this says. */
  model?: string;
  /** The tool mode sent with each request (`X-Faden-Tool-Mode`) unless a request says otherwise. Default `ask`. */
  toolMode?: ToolMode;
  /** Ask the gateway for its events (`X-Faden-Events: ag-ui`): tool rounds, approvals, notices. Default on. */
  gatewayEvents?: boolean;
  /** Allow `http://`. Off: agents use TLS. Only for a development server on this machine. */
  allowInsecureHttp?: boolean;
  fetch?: FetchLike;
  /** How long one request may take, in ms (default 5 min); for a stream it is the wait for the headers. */
  timeoutMs?: number;
  /** How long a streamed answer may send nothing at all before it is given up, in ms (default 5 min; `Infinity` turns it off). */
  streamIdleTimeoutMs?: number;
  /** Where the client logs: method, route, status and time of each request, never content or a token (see `FadenstackLogger`). */
  logger?: FadenstackLogger;
}

/**
 * The connection to a Fadenstack server. With an agent it is that agent's client -- one agent per client --
 * and `chat` calls the agent's endpoint; without one it uses the plain `/v1` routes with an API token.
 * .NET: `Fadenstack.FadenstackClient`.
 */
export class FadenstackClient {
  readonly options: Readonly<FadenstackClientOptions>;
  /** Authenticated requests, for modules that add their own resources. */
  readonly transport: FadenstackTransport;
  /** The gateway's chat completions. */
  readonly chat: FadenstackChatClient;
  /** The client's agent (profile, events, approvals); undefined without an agent. */
  readonly agent: AgentResource | undefined;
  /** The server's provenance routes: the anchors that check its signatures, and its detector (the agent's route, with an agent). */
  readonly provenance: ProvenanceResource;

  constructor(options: FadenstackClientOptions) {
    this.options = { ...options };
    const transport: TransportOptions = { serverUrl: options.serverUrl };
    if (options.apiUrl !== undefined) transport.apiUrl = options.apiUrl;
    if (options.credentials !== undefined) transport.credentials = options.credentials;
    if (options.allowInsecureHttp !== undefined) transport.allowInsecureHttp = options.allowInsecureHttp;
    if (options.fetch !== undefined) transport.fetch = options.fetch;
    if (options.timeoutMs !== undefined) transport.timeoutMs = options.timeoutMs;
    if (options.streamIdleTimeoutMs !== undefined) transport.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    if (options.logger !== undefined) transport.logger = options.logger;
    this.transport = new FadenstackTransport(transport);
    const chat: ChatClientSettings = {
      toolMode: options.toolMode ?? "ask",
      gatewayEvents: options.gatewayEvents ?? true,
    };
    if (options.agent !== undefined) chat.agent = options.agent;
    if (options.model !== undefined) chat.model = options.model;
    this.chat = new FadenstackChatClient(this.transport, chat);
    this.agent = options.agent ? new AgentResource(this.transport, options.agent) : undefined;
    this.provenance = new ProvenanceResource(this.transport, options.agent || undefined);
  }

  /** The server's edition and features (`GET /v1/features`). */
  getFeatures(signal?: AbortSignal): Promise<ServerFeatures> {
    return this.transport.get<ServerFeatures>(this.transport.gateway("v1/features"), signal);
  }

  /**
   * A client for `agent`, with its sign-in kept in `store` (in memory by default). Sign in once with
   * `tokens.signIn(loginToken)`.
   */
  static forAgent(
    options: Omit<FadenstackClientOptions, "agent" | "credentials"> & { agent: string; store?: TokenStore },
  ): { client: FadenstackClient; tokens: AgentTokenProvider } {
    const { store, ...rest } = options;
    const tokenOptions: AgentTokenProviderOptions = { apiUrl: options.apiUrl ?? options.serverUrl, agent: options.agent };
    if (store) tokenOptions.store = store;
    if (options.fetch) tokenOptions.fetch = options.fetch;
    // The same rule for the sign-in as for the client: a development server over http only where the app allows it.
    if (options.allowInsecureHttp !== undefined) tokenOptions.allowInsecureHttp = options.allowInsecureHttp;
    if (options.logger) tokenOptions.logger = options.logger;
    const tokens = new AgentTokenProvider(tokenOptions);
    return { client: new FadenstackClient({ ...rest, credentials: tokens }), tokens };
  }
}
