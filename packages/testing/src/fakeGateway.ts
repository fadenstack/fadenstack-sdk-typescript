import {
  decideTool,
  parseToolClass,
  parseToolMode,
  type ChatMessage,
  type FetchLike,
  type ToolClass,
  type ToolDefinition,
} from "@fadenstack/client";

/** A user the fake server knows. */
export interface FakeUser {
  email: string;
  password: string;
  id?: string;
  /** The agents granted to the user (slugs); all of them when not given. */
  agents?: string[];
  developerMode?: boolean;
  /** Has `agents:create`: may create agents (`POST /api/agents`), which they then maintain. */
  createsAgents?: boolean;
}

/** An agent the fake server serves. */
export interface FakeAgent {
  slug: string;
  name?: string;
  id?: string;
  version?: number;
  model?: string;
  /** The host tool contract, as the server keeps it: `[{ name, risk }]`. Empty: no restriction. */
  contract?: { name: string; risk?: "read" | "write" | "destructive"; approval?: string }[];
  ui?: Record<string, unknown>;
  localMcpMode?: "disable" | "allow";
  /** A tool-mode ceiling, as an administrator's rules set it. */
  ceiling?: "off" | "read_only" | "ask" | "auto";
  requiredClientModules?: string[];
}

/** One model call, as the fake model sees it. */
export interface FakeModelRequest {
  agent: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  stream: boolean;
  toolMode: string | null;
  conversationId: string | null;
  turnId: string | null;
  body: Record<string, unknown>;
}

/** What the fake model answers. Parts are sent in this order: events, gateway tool, reasoning, text, tool calls. */
export interface FakeReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; arguments?: Record<string, unknown> | string; id?: string }[];
  /** Raw gateway events (`event: faden`) sent first, e.g. citations or a PII notice. */
  events?: Record<string, unknown>[];
  /** The gateway refuses: the prompt (422) or the answer (`faden.governance`, finish `content_filter`). */
  refuse?: { stage: "input" | "output"; message: string; decisionId?: string; category?: string };
  /**
   * A tool the gateway runs itself before the answer: start and end events, the round to keep. With
   * `approval`, it first waits for the client's answer (`faden.approval_required`).
   */
  gatewayTool?: {
    name: string;
    arguments?: Record<string, unknown>;
    result?: string;
    /**
     * It waits for the client's answer. `rule` (whether an admin's rule asks) and `toolClass` are sent when given,
     * as a current gateway sends them; without them the event is an older gateway's.
     */
    approval?: { message?: string; timeoutS?: number; rule?: boolean; toolClass?: string };
  };
  /** A client tool the gateway refuses (`faden.tool_denied`), e.g. by a tool rule. */
  deniedTool?: { name: string; message: string; callId?: string };
  usage?: { prompt: number; completion: number };
  /** A stream error after the text (the answer broke off). */
  streamError?: { message: string; code?: string };
  /** A rate limit (429) instead of an answer. */
  rateLimit?: { retryAfterS?: number; code?: string; message?: string };
  /** Milliseconds between chunks. */
  delayMs?: number;
}

export type FakeModel = (request: FakeModelRequest) => FakeReply | Promise<FakeReply>;

/** An admin's tool rule, as the gateway applies it: the first whose pattern (`*` for any characters) matches. */
export interface FakeToolRule {
  pattern: string;
  action: "deny" | "approval_required";
  message: string;
}

export interface FakeGatewayOptions {
  agents?: FakeAgent[];
  users?: FakeUser[];
  model?: FakeModel;
  /** The URL the in-process `fetch` answers for (default `https://faden.test`). */
  serverUrl?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /** Characters per streamed text chunk (default 6). */
  chunkSize?: number;
  now?: () => number;
  /** The chat models `GET /v1/models` lists for a signed-in user (default `["fake-model"]`). */
  models?: string[];
  /**
   * The tenant's tool rules. As the gateway does: a tool a deny rule covers is not offered; a call of the client's
   * own tool that a rule says needs approval is marked (`faden.approval_required` without an approvalId,
   * `rule: true`), and such a tool is not offered to a client that does not read events.
   */
  toolRules?: FakeToolRule[];
}

/** A request the fake server got. */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface SignIn {
  deviceId: string;
  userId: string;
  agent: string;
  access: string;
  accessExpires: number;
  refresh: string;
  refreshExpires: number;
  revoked: boolean;
  label: string | null;
  /** Refresh tokens already used: a replay ends the sign-in. */
  spent: Set<string>;
}

/** The fields the real gateway accepts per event type (`extra=forbid`): anything else is a 422. */
const EVENT_FIELDS: Record<string, readonly string[]> = {
  "tool.executed": ["tool", "source", "server", "duration_ms", "outcome"],
  "approval.decided": ["tool", "decision", "wait_ms", "scope"],
  "local_mcp.attached": ["label", "command", "url", "tools"],
  "session.stats": ["turns", "compactions", "retention_sessions", "retention_days"],
};
const EVENT_COMMON = ["type", "occurred_at", "conversation_id"];
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A Fadenstack server in a box, for tests and demos: the backend's sign-in and agent tokens, and the gateway's
 * agent routes (profile, chat completions with events, events, approvals), with a scripted model. It checks
 * what the real server checks -- tokens, grants, the host tool contract, event fields -- so an SDK bug shows
 * here before it shows against a server.
 */
export class FakeGateway {
  readonly serverUrl: string;
  /** Every request, in order. */
  readonly requests: CapturedRequest[] = [];
  /** Every model call. */
  readonly modelCalls: FakeModelRequest[] = [];
  /** The events clients reported, as sent. */
  readonly reported: Record<string, unknown>[] = [];
  /** The manifests apps sent (`PUT /v1/agents/{agent}/manifest`), as sent. */
  readonly manifests: { agent: string; manifest: Record<string, unknown> }[] = [];
  /** Tools the gateway held back from requests because the contract does not list them. */
  readonly heldTools: string[] = [];
  /** Agents created through the API, by whom, with the body sent. */
  readonly createdAgents: { slug: string; by: string; body: Record<string, unknown> }[] = [];
  /** Answers to gateway approvals. */
  readonly approvals: { approvalId: string; approved: boolean }[] = [];
  readonly #agents: Map<string, Required<Pick<FakeAgent, "slug" | "name" | "id" | "version">> & FakeAgent>;
  readonly #users: (FakeUser & { id: string })[];
  readonly #signIns: SignIn[] = [];
  readonly #logins = new Map<string, string>();
  readonly #pendingApprovals = new Map<string, (approved: boolean) => void>();
  readonly #options: FakeGatewayOptions;
  #model: FakeModel;
  #counter = 0;

  constructor(options: FakeGatewayOptions = {}) {
    this.#options = options;
    this.serverUrl = (options.serverUrl ?? "https://faden.test").replace(/\/$/, "");
    const agents = options.agents ?? [{ slug: "test-agent" }];
    this.#agents = new Map(agents.map((a, i) => [a.slug, { name: a.slug, id: `agent-${i + 1}`, version: 1, ...a }]));
    this.#users = (options.users ?? [{ email: "user@example.com", password: "secret" }]).map((u, i) => ({ id: `user-${i + 1}`, ...u }));
    this.#model = options.model ?? (() => ({ text: "Hello from the fake gateway." }));
  }

  /** Replaces the model. */
  setModel(model: FakeModel): void {
    this.#model = model;
  }

  /** Ends every sign-in (or one device's), as revoking a grant does. */
  revoke(deviceId?: string): void {
    for (const s of this.#signIns) if (!deviceId || s.deviceId === deviceId) s.revoked = true;
  }

  /** Makes every access token expire now, so the next request refreshes. */
  expireAccessTokens(): void {
    for (const s of this.#signIns) s.accessExpires = 0;
  }

  /** The devices signed in, for assertions. */
  get signIns(): readonly { deviceId: string; agent: string; userId: string; label: string | null; revoked: boolean }[] {
    return this.#signIns.map(({ deviceId, agent, userId, label, revoked }) => ({ deviceId, agent, userId, label, revoked }));
  }

  /** An in-process `fetch` that answers for `serverUrl`. */
  readonly fetch: FetchLike = (input, init) => this.handle(new Request(input instanceof URL ? input.href : input, init));

  /** Answers one request. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let body: unknown = text;
    if ((request.headers.get("content-type") ?? "").includes("json") && text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { detail: "Invalid JSON." });
      }
    } else if ((request.headers.get("content-type") ?? "").includes("form")) {
      body = Object.fromEntries(new URLSearchParams(text));
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    this.requests.push({ method: request.method, path: url.pathname, headers, body });
    try {
      return await this.#route(request, url, body);
    } catch (error) {
      return json(500, { detail: `Fake gateway: ${(error as Error).message}` });
    }
  }

  /** Serves the fake over HTTP on this machine (for a browser or another process). */
  async listen(port = 0, host = "127.0.0.1"): Promise<{ url: string; close: () => Promise<void> }> {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const init: RequestInit = { method: req.method ?? "GET", headers: req.headers as Record<string, string> };
        if (chunks.length) init.body = Buffer.concat(chunks);
        void this.handle(new Request(`http://${host}${req.url ?? "/"}`, init)).then(async (response) => {
          const out: Record<string, string> = {};
          response.headers.forEach((value, key) => (out[key] = value));
          res.writeHead(response.status, out);
          if (!response.body) return void res.end();
          const reader = response.body.getReader();
          req.on("close", () => void reader.cancel().catch(() => undefined));
          for (;;) {
            const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
            if (done) break;
            res.write(value);
          }
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://${host}:${actual}`,
      close: () => new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    };
  }

  // -- routes ---------------------------------------------------------------------------------------

  async #route(request: Request, url: URL, body: unknown): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    if (method === "POST" && path === "/api/auth/jwt/login") return this.#login(body);
    if (method === "POST" && path === "/api/agent-tokens") return this.#issue(request, body);
    if (method === "POST" && path === "/api/agents") return this.#createAgent(request, body);
    if (method === "POST" && path === "/api/agent-tokens/refresh") return this.#refresh(body);
    if (method === "GET" && path === "/api/health") return json(200, { status: "ok" });
    if (method === "GET" && path === "/v1/features") return json(200, { edition: "community", features: ["agents"] });
    if (method === "GET" && path === "/v1/models") {
      if (!this.#logins.has(bearer(request) ?? "")) return openAiError(401, "The token is not valid.", "invalid_token", "authentication_error");
      return json(200, { object: "list", data: (this.#options.models ?? ["fake-model"]).map((id) => ({ id, object: "model" })) });
    }
    const match = /^\/v1\/agents\/([^/]+)\/(profile|chat\/completions|events|manifest|approvals\/([^/]+))$/.exec(path);
    if (!match) return json(404, { detail: "Not Found" });
    const agent = decodeURIComponent(match[1]!);
    const auth = this.#authorize(request, agent);
    if (auth instanceof Response) return auth;
    const route = match[2]!;
    if (method === "GET" && route === "profile") return json(200, this.#profile(agent, auth));
    if (method === "POST" && route === "chat/completions") return this.#chat(request, agent, body);
    if (method === "POST" && route === "events") return this.#events(body);
    if (method === "PUT" && route === "manifest") return this.#manifest(agent, body);
    if (method === "POST" && route.startsWith("approvals/")) return this.#approve(decodeURIComponent(match[3]!), body);
    return json(405, { detail: "Method Not Allowed" });
  }

  #login(body: unknown): Response {
    const form = (body ?? {}) as Record<string, string>;
    const user = this.#users.find((u) => u.email === form["username"] && u.password === form["password"]);
    if (!user) return json(400, { detail: "LOGIN_BAD_CREDENTIALS" });
    const token = `login.${user.id}.${this.#next()}`;
    this.#logins.set(token, user.id);
    return json(200, { access_token: token, token_type: "bearer" });
  }

  #issue(request: Request, body: unknown): Response {
    const userId = this.#logins.get(bearer(request) ?? "");
    if (!userId) return json(401, { detail: "Unauthorized" });
    const b = (body ?? {}) as Record<string, unknown>;
    const agent = this.#agents.get(String(b["agent"] ?? ""));
    if (!agent) return json(404, { detail: "Agent not found" });
    const user = this.#users.find((u) => u.id === userId)!;
    if (user.agents && !user.agents.includes(agent.slug)) {
      return json(403, { detail: { code: "no_grant", message: "Neither the user nor a team of theirs is granted the agent." } });
    }
    const label = typeof b["device_label"] === "string" ? (b["device_label"] as string) : null;
    if (label !== null && label.length > 200) return json(422, { detail: [{ msg: "device_label is too long" }] });
    const signIn: SignIn = {
      deviceId: `device-${this.#next()}`, userId, agent: agent.slug, access: "", accessExpires: 0, refresh: "",
      refreshExpires: 0, revoked: false, label, spent: new Set(),
    };
    this.#signIns.push(signIn);
    return json(201, this.#tokens(signIn, agent.id));
  }

  /** A new agent as a draft its creator maintains (and so may use), for someone with agents:create. */
  #createAgent(request: Request, body: unknown): Response {
    const userId = this.#logins.get(bearer(request) ?? "");
    if (!userId) return json(401, { detail: "Unauthorized" });
    const user = this.#users.find((u) => u.id === userId)!;
    if (!user.createsAgents) return json(403, { detail: "Permission denied: agents:create" });
    const b = (body ?? {}) as Record<string, unknown>;
    const slug = String(b["slug"] ?? "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug) || !b["name"]) {
      return json(422, { detail: [{ msg: "slug and name are required" }] });
    }
    if (this.#agents.has(slug)) return json(409, { detail: `An agent '${slug}' exists.` });
    const version = (b["version"] ?? {}) as Record<string, unknown>;
    const agent = {
      slug, name: String(b["name"]), id: `agent-${this.#agents.size + 1}`, version: 1,
      contract: (version["host_tool_contract"] ?? []) as FakeAgent["contract"],
      ui: (version["ui"] ?? {}) as Record<string, unknown>,
      ...(typeof version["model_alias"] === "string" ? { model: version["model_alias"] } : {}),
    };
    this.#agents.set(slug, agent);
    if (user.agents) user.agents.push(slug);
    this.createdAgents.push({ slug, by: user.email, body: b });
    return json(201, { id: agent.id, slug, name: agent.name, status: "draft", published_version: null, latest_version: 1 });
  }

  #refresh(body: unknown): Response {
    const token = String(((body ?? {}) as Record<string, unknown>)["refresh_token"] ?? "");
    const signIn = this.#signIns.find((s) => s.refresh === token || s.spent.has(token));
    if (!signIn || signIn.revoked) return json(401, { detail: { code: "invalid_refresh_token", message: "Sign in again." } });
    if (signIn.spent.has(token)) {
      signIn.revoked = true; // a replayed refresh token ends the whole sign-in
      return json(401, { detail: { code: "refresh_token_reused", message: "This sign-in was ended: its refresh token was used twice." } });
    }
    if (signIn.refreshExpires <= this.#now()) return json(401, { detail: { code: "expired", message: "The sign-in expired." } });
    signIn.spent.add(token);
    return json(200, this.#tokens(signIn, this.#agents.get(signIn.agent)!.id));
  }

  #tokens(signIn: SignIn, agentId: string): Record<string, unknown> {
    const access = this.#options.accessTtlSeconds ?? 600;
    const refresh = this.#options.refreshTtlSeconds ?? 86_400;
    signIn.access = `access.${signIn.deviceId}.${this.#next()}`;
    signIn.refresh = `refresh.${signIn.deviceId}.${this.#next()}`;
    signIn.accessExpires = this.#now() + access * 1000;
    signIn.refreshExpires = this.#now() + refresh * 1000;
    return {
      access_token: signIn.access, token_type: "bearer", expires_in: access, refresh_token: signIn.refresh,
      refresh_expires_in: refresh, device_id: signIn.deviceId, agent_id: agentId, agent: signIn.agent,
    };
  }

  #authorize(request: Request, agent: string): SignIn | Response {
    const token = bearer(request);
    if (!token) return openAiError(401, "Missing Authorization header.", "missing_authorization", "invalid_request_error");
    const signIn = this.#signIns.find((s) => s.access === token);
    if (!signIn || signIn.revoked || signIn.accessExpires <= this.#now()) {
      return openAiError(401, "The token is not valid.", "invalid_token", "authentication_error");
    }
    if (signIn.agent !== agent) return openAiError(403, "This token is for another agent.", "agent_mismatch", "permission_error");
    return signIn;
  }

  #profile(slug: string, signIn: SignIn): Record<string, unknown> {
    const agent = this.#agents.get(slug)!;
    const user = this.#users.find((u) => u.id === signIn.userId)!;
    return {
      object: "agent.profile", id: agent.id, slug: agent.slug, name: agent.name, version: agent.version, draft: false,
      model: agent.model ?? "fake-model", instructions_sha256: "0".repeat(64),
      host_tool_contract: agent.contract ?? [], server_tools: null, knowledge: [],
      local_mcp: { mode: agent.localMcpMode ?? "disable", developer_mode: user.developerMode ?? false },
      tool_modes: { default: "ask", ceiling: agent.ceiling ?? null, open_world_enforced: false },
      ui: agent.ui ?? {}, extensions: {}, required_client_modules: agent.requiredClientModules ?? [],
      edition: "community", features: ["agents"],
    };
  }

  async #chat(request: Request, slug: string, body: unknown): Promise<Response> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["messages"]) || typeof b["model"] !== "string") {
      return openAiError(400, "model and messages are required.", "invalid_request", "invalid_request_error");
    }
    const agent = this.#agents.get(slug)!;
    const tools: ToolDefinition[] = (Array.isArray(b["tools"]) ? b["tools"] : []).map((t: Record<string, unknown>) => {
      const fn = (t["function"] ?? {}) as Record<string, unknown>;
      const def: ToolDefinition = { name: String(fn["name"] ?? "") };
      if (typeof fn["description"] === "string") def.description = fn["description"];
      if (fn["parameters"]) def.parameters = fn["parameters"] as ToolDefinition["parameters"];
      return def;
    });
    // As the gateway does: tools outside the contract are held back -- the model never sees them -- and named.
    const contract = agent.contract ?? [];
    const held = contract.length ? tools.filter((t) => !contract.some((c) => c.name === t.name)) : [];
    if (held.length) this.heldTools.push(...held.map((t) => t.name));
    const events = request.headers.get("x-faden-events") !== null;
    // A tool a rule refuses is not offered, nor one a rule asks about to a client that cannot be told.
    const refused = tools.filter((t) => !held.includes(t) && this.#refusedAtOffer(t.name, events));
    const offered = tools.filter((t) => !held.includes(t) && !refused.includes(t));
    const leading = refused.map((t) => toolDenied("", t.name, this.#rule(t.name)!.message, this.#decision()));
    const screen = (calls: WireCall[]) =>
      events ? [...leading, ...this.#screen(agent, request.headers.get("x-faden-tool-mode"), calls)] : [];
    const modelRequest: FakeModelRequest = {
      agent: slug, messages: b["messages"] as ChatMessage[], tools: offered, stream: b["stream"] === true,
      toolMode: request.headers.get("x-faden-tool-mode"), conversationId: request.headers.get("x-faden-conversation-id"),
      turnId: request.headers.get("x-faden-turn-id"), body: b,
    };
    this.modelCalls.push(modelRequest);
    const reply = await this.#model(modelRequest);
    if (reply.rateLimit) {
      const headers: Record<string, string> = {};
      if (reply.rateLimit.retryAfterS !== undefined) headers["retry-after"] = String(reply.rateLimit.retryAfterS);
      return openAiError(429, reply.rateLimit.message ?? "Too many requests.", reply.rateLimit.code ?? "rate_limit_rpm",
        "rate_limit_error", headers);
    }
    if (reply.refuse?.stage === "input") {
      const governance = this.#governance("prompt_blocked", "input", reply.refuse);
      return json(422, {
        error: { message: reply.refuse.message, type: "governance_error", param: null, code: "policy_blocked" },
        faden: { governance },
      });
    }
    const response = modelRequest.stream ? this.#stream(reply, events, screen) : this.#whole(reply, events, screen);
    if (held.length) response.headers.set("x-faden-held-tools", held.map((t) => t.name).sort().join(","));
    return response;
  }

  /** What the app brings, checked as the gateway checks it, and kept in `manifests`. */
  #manifest(agent: string, body: unknown): Response {
    const m = (body ?? {}) as Record<string, unknown>;
    const app = (m["app"] ?? {}) as Record<string, unknown>;
    const tools = Array.isArray(m["tools"]) ? (m["tools"] as Record<string, unknown>[]) : [];
    const names = tools.map((t) => String(t["name"] ?? ""));
    const problem = !app["name"] ? "app.name is required"
      : names.some((n) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(n)) ? "a tool name is not valid"
      : new Set(names).size !== names.length ? "tool names must be unique"
      : tools.some((t) => !["read", "write", "destructive", "unknown", undefined].includes(t["class"] as string)) ? "a tool class is not valid"
      : undefined;
    if (problem) return openAiError(400, problem, "invalid_manifest", "invalid_request_error");
    const key = JSON.stringify(m);
    const isNew = !this.manifests.some((x) => x.agent === agent && JSON.stringify(x.manifest) === key);
    this.manifests.push({ agent, manifest: m });
    return json(200, { sha256: `fake-${this.manifests.length}`, new: isNew });
  }

  #governance(outcome: string, stage: string, refuse: NonNullable<FakeReply["refuse"]>): Record<string, unknown> {
    return {
      outcome, stage, category: refuse.category ?? "policy", message: refuse.message,
      decision_id: refuse.decisionId ?? `decision-${this.#next()}`, request_id: `request-${this.#next()}`,
    };
  }

  /** Whether a rule keeps `name` from being offered at all. */
  #refusedAtOffer(name: string, events: boolean): boolean {
    const rule = this.#rule(name);
    return rule !== undefined && (rule.action === "deny" || !events);
  }

  #rule(name: string): FakeToolRule | undefined {
    return (this.#options.toolRules ?? []).find((r) => globMatch(r.pattern, name));
  }

  /**
   * What the gateway says about the client's own calls as it hands them over: a call a rule refuses or the mode
   * hides is `faden.tool_denied`; one a rule or the mode asks about is `faden.approval_required` without an
   * approvalId, with the class the gateway holds (the contract's risk, else unknown) and whether a rule asks.
   */
  #screen(agent: FakeAgent, modeHeader: string | null, calls: WireCall[]): Record<string, unknown>[] {
    const mode = parseToolMode(modeHeader) ?? "ask";
    const events: Record<string, unknown>[] = [];
    for (const call of calls) {
      const name = call.function.name;
      const rule = this.#rule(name);
      const toolClass: ToolClass = parseToolClass((agent.contract ?? []).find((c) => c.name === name)?.risk);
      const decision = decideTool(mode, toolClass);
      if (rule?.action === "deny" || decision === "hidden") {
        events.push(toolDenied(call.id, name, rule?.action === "deny" ? rule.message : `The tool mode is ${mode}.`, this.#decision()));
      } else if (rule?.action === "approval_required") {
        events.push({ type: "CUSTOM", name: "faden.approval_required", value: {
          toolCallId: call.id, toolCallName: name, message: rule.message, decisionId: this.#decision(), toolClass, rule: true,
        } });
      } else if (decision === "ask") {
        events.push({ type: "CUSTOM", name: "faden.approval_required", value: {
          toolCallId: call.id, toolCallName: name, message: `'${name}' is ${toolClass}; the tool mode is ${mode}.`,
          decisionId: null, toolClass, rule: false,
        } });
      }
    }
    return events;
  }

  #decision(): string {
    return `decision-${this.#next()}`;
  }

  #whole(reply: FakeReply, events: boolean, screen: (calls: WireCall[]) => Record<string, unknown>[]): Response {
    const message: Record<string, unknown> = { role: "assistant", content: reply.text ?? null };
    if (reply.reasoning) message["reasoning_content"] = reply.reasoning;
    const calls = this.#calls(reply);
    if (calls.length) message["tool_calls"] = calls;
    const out: Record<string, unknown> = {
      id: `chatcmpl-${this.#next()}`, object: "chat.completion", model: "fake-model",
      choices: [{ index: 0, message, finish_reason: reply.refuse ? "content_filter" : calls.length ? "tool_calls" : "stop" }],
      usage: usage(reply),
    };
    const faden: Record<string, unknown> = {};
    const all = [...(reply.events ?? []), ...screen(calls)];
    if (events && all.length) faden["events"] = all;
    if (reply.refuse?.stage === "output") faden["governance"] = this.#governance("response_blocked", "output", reply.refuse);
    if (Object.keys(faden).length) out["faden"] = faden;
    return json(200, out);
  }

  #stream(reply: FakeReply, events: boolean, screen: (calls: WireCall[]) => Record<string, unknown>[]): Response {
    const id = `chatcmpl-${this.#next()}`;
    const chunkSize = this.#options.chunkSize ?? 6;
    const encoder = new TextEncoder();
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const faden = (event: Record<string, unknown>) => (events ? `event: faden\ndata: ${JSON.stringify(event)}\n\n` : "");
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = async (text: string) => {
          if (!text) return;
          controller.enqueue(encoder.encode(text));
          if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        };
        try {
          for (const event of reply.events ?? []) await send(faden(event));
          if (reply.gatewayTool) await self.#gatewayTool(reply.gatewayTool, send, faden);
          if (reply.deniedTool) {
            await send(faden({ type: "CUSTOM", name: "faden.tool_denied", value: {
              toolCallId: reply.deniedTool.callId ?? "", toolCallName: reply.deniedTool.name,
              message: reply.deniedTool.message, decisionId: `decision-${self.#next()}`,
            } }));
          }
          await send(chunk({ role: "assistant", content: "" }));
          for (let i = 0; reply.reasoning && i < reply.reasoning.length; i += chunkSize) {
            await send(chunk({ reasoning_content: reply.reasoning.slice(i, i + chunkSize) }));
          }
          for (let i = 0; reply.text && i < reply.text.length; i += chunkSize) {
            await send(chunk({ content: reply.text.slice(i, i + chunkSize) }));
          }
          if (reply.refuse?.stage === "output") {
            await send(faden({ type: "CUSTOM", name: "faden.governance",
              value: self.#governance("response_blocked", "output", reply.refuse) }));
            await send(chunk({}, "content_filter"));
          } else if (reply.streamError) {
            await send(`data: ${JSON.stringify({ error: { message: reply.streamError.message, code: reply.streamError.code ?? "upstream_error" } })}\n\n`);
          } else {
            const calls = self.#calls(reply);
            for (const event of screen(calls)) await send(faden(event));
            calls.forEach((call, index) => {
              // Split each call over two chunks, as models stream them.
              const args = call.function.arguments;
              const half = Math.floor(args.length / 2);
              controller.enqueue(encoder.encode(chunk({ tool_calls: [{ index, id: call.id, type: "function",
                function: { name: call.function.name, arguments: args.slice(0, half) } }] })));
              controller.enqueue(encoder.encode(chunk({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] })));
            });
            await send(chunk({}, calls.length ? "tool_calls" : "stop"));
          }
          await send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fake-model", choices: [], usage: usage(reply) })}\n\n`);
          await send("data: [DONE]\n\n");
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  async #gatewayTool(
    tool: NonNullable<FakeReply["gatewayTool"]>,
    send: (text: string) => Promise<void>,
    faden: (event: Record<string, unknown>) => string,
  ): Promise<void> {
    const callId = `gw-${this.#next()}`;
    if (tool.approval) {
      const approvalId = `approval-${this.#next()}`;
      const answered = new Promise<boolean>((resolve) => {
        this.#pendingApprovals.set(approvalId, resolve);
        setTimeout(() => resolve(false), (tool.approval!.timeoutS ?? 300) * 1000);
      });
      await send(faden({ type: "CUSTOM", name: "faden.approval_required", value: {
        approvalId, toolCallId: callId, toolCallName: tool.name, message: tool.approval.message ?? `Run ${tool.name}?`,
        timeoutS: tool.approval.timeoutS ?? 300,
        ...(tool.approval.toolClass !== undefined ? { toolClass: tool.approval.toolClass } : {}),
        ...(tool.approval.rule !== undefined ? { rule: tool.approval.rule } : {}),
      } }));
      const approved = await answered;
      this.#pendingApprovals.delete(approvalId);
      if (!approved) {
        await send(faden({ type: "CUSTOM", name: "faden.tool_denied", value: {
          toolCallId: callId, toolCallName: tool.name, message: "The user declined it.", decisionId: null,
        } }));
        return;
      }
    }
    await send(faden({ type: "TOOL_CALL_START", toolCallId: callId, toolCallName: tool.name, kind: "system" }));
    await send(faden({ type: "TOOL_CALL_END", toolCallId: callId, toolCallName: tool.name, durationMs: 12, error: false }));
    await send(faden({ type: "CUSTOM", name: "faden.gateway_round", value: { messages: [
      { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments ?? {}) } }] },
      { role: "tool", tool_call_id: callId, content: tool.result ?? "done" },
    ] } }));
  }

  #events(body: unknown): Response {
    const events = ((body ?? {}) as Record<string, unknown>)["events"];
    if (!Array.isArray(events) || events.length < 1 || events.length > 100) {
      return json(422, { detail: [{ msg: "events must hold 1 to 100 events" }] });
    }
    for (const event of events as Record<string, unknown>[]) {
      const allowed = EVENT_FIELDS[String(event["type"])];
      if (!allowed) return json(422, { detail: [{ msg: `unknown event type ${String(event["type"])}` }] });
      const extra = Object.keys(event).filter((k) => !allowed.includes(k) && !EVENT_COMMON.includes(k));
      if (extra.length) return json(422, { detail: [{ msg: `extra fields not permitted: ${extra.join(", ")}` }] });
      const conversation = event["conversation_id"];
      if (conversation !== undefined && conversation !== null && !ID_PATTERN.test(String(conversation))) {
        return json(422, { detail: [{ msg: "conversation_id does not match the pattern" }] });
      }
    }
    this.reported.push(...(events as Record<string, unknown>[]));
    return json(202, { accepted: events.length });
  }

  #approve(approvalId: string, body: unknown): Response {
    const approved = ((body ?? {}) as Record<string, unknown>)["approved"] === true;
    const pending = this.#pendingApprovals.get(approvalId);
    if (!pending) return json(404, { detail: "No such approval." });
    this.approvals.push({ approvalId, approved });
    pending(approved);
    return json(200, { status: approved ? "approved" : "rejected" });
  }

  #calls(reply: FakeReply): WireCall[] {
    return (reply.toolCalls ?? []).map((c) => ({
      id: c.id ?? `call_${this.#next()}`,
      type: "function" as const,
      function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    }));
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #next(): string {
    this.#counter += 1;
    return String(this.#counter);
  }
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function openAiError(status: number, message: string, code: string, type: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { message, type, param: null, code } }, headers);
}

function usage(reply: FakeReply): Record<string, number> {
  const prompt = reply.usage?.prompt ?? 10;
  const completion = reply.usage?.completion ?? Math.max(1, Math.ceil((reply.text ?? "").length / 4));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** The last user message's text (attachments and all), for a fake model's rules. */
export function lastUserText(request: FakeModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join("");
  }
  return "";
}

/** The results of the tools the model called last, by tool call id (empty before any tool ran). */
export function lastToolResults(request: FakeModelRequest): Map<string, string> {
  const results = new Map<string, string>();
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role !== "tool") break;
    results.set(m.tool_call_id, m.content);
  }
  return results;
}

/** A tool call as the model sends it. */
type WireCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function toolDenied(callId: string, name: string, message: string, decisionId: string): Record<string, unknown> {
  return { type: "CUSTOM", name: "faden.tool_denied", value: { toolCallId: callId, toolCallName: name, message, decisionId } };
}

/** A tool rule's pattern: `*` stands for any characters, everything else for itself (fnmatch, as the gateway). */
function globMatch(pattern: string, name: string): boolean {
  const parts = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(name);
}
