import {
  DEFAULT_PROVENANCE_POLICY,
  MARK_LAYERS,
  PROVENANCE_CONTRACT,
  REASON_CODES,
  RECEIPT_HEADER,
  bytesSha256,
  decideTool,
  digitalSourceType,
  isEditKind,
  parseToolClass,
  parseToolMode,
  textSha256,
  type ChatMessage,
  type EditKind,
  type FetchLike,
  type GenerationReceipt,
  type PlacementReport,
  type ProvenancePolicy,
  type ProvenanceRecordPayload,
  type SignedRecord,
  type ToolClass,
  type ToolDefinition,
  type WatermarkStatus,
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
  /** The language the user picked for every client (`user.language` in the profile); `PATCH .../user` changes it. */
  language?: string | null;
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
  /** Whether its model sees pictures (`vision` in the profile); not said by default, as an older server. */
  vision?: boolean;
  /**
   * The skills its users can pick (`GET .../skills`; the profile says `skills: true`). Without it the server has no
   * skills module: the route answers `available: false`.
   */
  skills?: { slug: string; name?: string; description?: string; activation?: string }[];
  /** Its marking policy, over the server's (`provenance.policy`): `GET .../provenance/policy` answers with both. */
  provenancePolicy?: ProvenancePolicy;
}

/**
 * The server's provenance module, as the agents' routes show it: the policy, signed records, placement reports, the
 * anchors and the detector. On by default; receipts on chat answers only when `receipts` is on.
 */
export interface FakeProvenanceOptions {
  /** False: a server without the module, whose provenance routes answer 404. */
  enabled?: boolean;
  /** The module's service is not running: its routes answer 503 and streamed answers end with an unsigned receipt. */
  down?: boolean;
  /**
   * Chat answers carry receipts: a streamed one ends with a `faden.provenance` event, one that was not streamed
   * names its receipt in `x-faden-provenance`. Off by default, so a turn's events are only the model's.
   */
  receipts?: boolean;
  /** The server's policy; the contract's defaults where it says nothing. */
  policy?: ProvenancePolicy;
  /** What receipts say about the watermark (default: none, the runtime does not watermark). */
  watermark?: WatermarkStatus;
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
  /** The finish reason, in place of the one its parts give (`tool_calls` or `stop`): `length` for a model out of tokens. */
  finish?: string;
  /** A rate limit (429) instead of an answer. */
  rateLimit?: { retryAfterS?: number; code?: string; message?: string };
  /** Milliseconds between chunks. */
  delayMs?: number;
  /**
   * This answer's receipt, when the server sends receipts (`provenance.receipts`): false sends none, `unsigned` one
   * the server could not sign, `watermark` what it says about the watermark.
   */
  receipt?: false | { unsigned?: boolean; watermark?: WatermarkStatus };
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
  provenance?: FakeProvenanceOptions;
}

/** A record the fake server signed, with the agent and the request it was signed for. */
export interface FakeSignedRecord {
  agent: string;
  request: Record<string, unknown>;
  signed: SignedRecord;
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
  /** The records the server signed for placements, in order. */
  readonly provenanceRecords: FakeSignedRecord[] = [];
  /** The placement reports clients sent, as sent. */
  readonly placements: { agent: string; report: PlacementReport }[] = [];
  /** The receipts chat answers carried, in order. */
  readonly receipts: GenerationReceipt[] = [];
  #provenanceDown: boolean;
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
    this.#provenanceDown = options.provenance?.down ?? false;
  }

  /** Replaces the model. */
  setModel(model: FakeModel): void {
    this.#model = model;
  }

  /** Stops or starts the provenance module's service (`provenance.down`). */
  setProvenanceDown(down: boolean): void {
    this.#provenanceDown = down;
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
    if (path === "/v1/provenance/anchors" || path === "/v1/provenance/verify") return this.#provenanceRoute(request, path, body);
    const match = /^\/v1\/agents\/([^/]+)\/(profile|user|skills|chat\/completions|events|manifest|approvals\/([^/]+)|provenance\/(policy|records|placements|verify))$/
      .exec(path);
    if (!match) return json(404, { detail: "Not Found" });
    const agent = decodeURIComponent(match[1]!);
    const auth = this.#authorize(request, agent);
    if (auth instanceof Response) return auth;
    const route = match[2]!;
    if (method === "GET" && route === "profile") return json(200, this.#profile(agent, auth));
    if (method === "GET" && route === "skills") return json(200, this.#skills(agent, url));
    if (method === "PATCH" && route === "user") return this.#userSettings(auth, body);
    if (method === "POST" && route === "chat/completions") return this.#chat(request, agent, body);
    if (method === "POST" && route === "events") return this.#events(body);
    if (method === "PUT" && route === "manifest") return this.#manifest(agent, body);
    if (method === "POST" && route.startsWith("approvals/")) return this.#approve(decodeURIComponent(match[3]!), body);
    if (route.startsWith("provenance/")) return this.#agentProvenance(method, agent, match[4]!, body);
    return json(405, { detail: "Method Not Allowed" });
  }

  // -- provenance -----------------------------------------------------------------------------------

  /** A provenance route's answer when the module is missing (404) or down (503), else undefined. */
  #provenanceUnavailable(): Response | undefined {
    if (this.#options.provenance?.enabled === false) return json(404, { detail: "Not Found" });
    if (this.#provenanceDown) {
      return openAiError(503, "The provenance service is not available.", "provenance_unavailable", "server_error");
    }
    return undefined;
  }

  /** `.../provenance/policy`, `records` and `placements`, checked as the gateway checks them (no extra fields). */
  async #agentProvenance(method: string, agent: string, route: string, body: unknown): Promise<Response> {
    const unavailable = this.#provenanceUnavailable();
    if (unavailable) return unavailable;
    if (method === "GET" && route === "policy") {
      return json(200, { ...DEFAULT_PROVENANCE_POLICY, ...this.#options.provenance?.policy, ...this.#agents.get(agent)!.provenancePolicy });
    }
    if (method === "POST" && route === "records") return this.#signRecord(agent, body);
    if (method === "POST" && route === "verify") return this.#verify(body);
    if (method === "POST" && route === "placements") {
      const problem = placementProblem(body);
      if (problem) return json(422, { detail: [{ msg: problem }] });
      this.placements.push({ agent, report: body as PlacementReport });
      return json(202, { stored: true });
    }
    return json(405, { detail: "Method Not Allowed" });
  }

  async #signRecord(agent: string, body: unknown): Promise<Response> {
    const b = (body ?? {}) as Record<string, unknown>;
    const allowed = ["content_sha256", "text_sha256", "media_type", "edit_kind", "receipt_id", "model"];
    const extra = Object.keys(b).filter((k) => !allowed.includes(k));
    const problem = extra.length ? `extra fields not permitted: ${extra.join(", ")}`
      : typeof b["content_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(b["content_sha256"]) ? "content_sha256 is a SHA-256 in hex"
      : b["text_sha256"] !== undefined && b["text_sha256"] !== null
        && (typeof b["text_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(b["text_sha256"])) ? "text_sha256 is a SHA-256 in hex"
      : typeof b["media_type"] !== "string" || !b["media_type"] ? "media_type is required"
      : !isEditKind(b["edit_kind"]) ? "edit_kind is not an edit kind"
      : ["receipt_id", "model"].some((k) => b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") ? "receipt_id and model are strings"
      : undefined;
    if (problem) return json(422, { detail: [{ msg: problem }] });
    const record: ProvenanceRecordPayload = {
      contract: PROVENANCE_CONTRACT,
      id: globalThis.crypto.randomUUID(),
      digital_source_type: digitalSourceType(b["edit_kind"] as EditKind),
      edit_kind: b["edit_kind"] as EditKind,
      system: { name: "Fadenstack", version: "fake" },
      provider: "Example organisation",
      model: typeof b["model"] === "string" ? { id: b["model"], version: null } : null,
      created_at: new Date(this.#now()).toISOString(),
      receipt_id: typeof b["receipt_id"] === "string" ? b["receipt_id"] : null,
      media_type: b["media_type"] as string,
      content_hash: await keyedHash(b["content_sha256"] as string),
      hash_key_version: 1,
      text_hash: typeof b["text_sha256"] === "string" ? await keyedHash(b["text_sha256"]) : null,
    };
    const signed: SignedRecord = { record, signature: fakeJws(record), timestamp: null };
    this.provenanceRecords.push({ agent, request: b, signed });
    return json(200, signed);
  }

  /**
   * `GET /v1/provenance/anchors` (anyone) and `POST /v1/provenance/verify` (a signed-in user; an agent token is
   * refused there, as the gateway refuses it outside its agent's routes).
   */
  async #provenanceRoute(request: Request, path: string, body: unknown): Promise<Response> {
    const unavailable = this.#provenanceUnavailable();
    if (unavailable) return unavailable;
    if (path === "/v1/provenance/anchors" && request.method === "GET") {
      return json(200, {
        contract: PROVENANCE_CONTRACT, signing_chains: [FAKE_CERTIFICATE], trust_anchors: [FAKE_CERTIFICATE],
        detector: { id: "fadenstack-provenance/fake", methods: ["record"] },
      });
    }
    if (path !== "/v1/provenance/verify" || request.method !== "POST") return json(405, { detail: "Method Not Allowed" });
    const token = bearer(request) ?? "";
    if (this.#signIns.some((s) => s.access === token && !s.revoked && s.accessExpires > this.#now())) {
      return openAiError(403, "Agent tokens are accepted only on their agent's routes (/v1/agents/{agent}/...).",
        "agent_token_not_allowed", "permission_error");
    }
    if (!this.#logins.has(token)) return openAiError(401, "The token is not valid.", "invalid_token", "authentication_error");
    return this.#verify(body);
  }

  /**
   * The detector, as both verify routes run it: the content's hash looked up among the records signed here, as the
   * content's or as the text a reader sees of HTML and Markdown.
   */
  async #verify(body: unknown): Promise<Response> {
    const b = (body ?? {}) as Record<string, unknown>;
    const text = typeof b["text"] === "string" ? b["text"] : undefined;
    const file = typeof b["file"] === "string" ? Uint8Array.from(atob(b["file"]), (c) => c.charCodeAt(0)) : undefined;
    if ((text === undefined) === (file === undefined)) {
      return openAiError(400, "Send either text or file, not both and not neither.", "validation_error", "invalid_request_error");
    }
    const sha = text !== undefined ? await textSha256(text) : await bytesSha256(file!);
    const hash = await keyedHash(sha);
    const found = this.provenanceRecords.find((r) => r.signed.record.content_hash === hash || r.signed.record.text_hash === hash);
    return json(200, {
      contract: PROVENANCE_CONTRACT,
      verdict: found ? "ai-generated" : "no-mark-found",
      findings: [{
        layer: "metadata", method: "record", found: found !== undefined,
        detail: found ? "A signed record of this installation matches the content." : "No record matches the content.",
        record_id: found?.signed.record.id ?? null, receipt_id: found?.signed.record.receipt_id ?? null, score: null,
      }],
      content_hash: sha, detector: "fadenstack-provenance/fake", checked_at: new Date(this.#now()).toISOString(), signature: null,
    });
  }

  /**
   * The receipt an answer ends with, when the server sends receipts: the event's value (`faden.provenance`), or
   * undefined for none. A refused or broken-off answer gets none.
   */
  #receipt(reply: FakeReply, agent: FakeAgent): { value: Record<string, unknown>; id?: string } | undefined {
    if (!this.#options.provenance?.receipts || this.#options.provenance.enabled === false || reply.receipt === false) return undefined;
    if (reply.refuse || reply.streamError || (!reply.text && !reply.toolCalls?.length)) return undefined;
    if (this.#provenanceDown || reply.receipt?.unsigned) return { value: { receipt: null, status: "unsigned", reason: "server-unavailable" } };
    const id = globalThis.crypto.randomUUID();
    const receipt: GenerationReceipt = {
      contract: PROVENANCE_CONTRACT, id, kind: "text", model: { id: agent.model ?? "fake-model", version: null },
      created_at: new Date(this.#now()).toISOString(),
      watermark: reply.receipt?.watermark ?? this.#options.provenance.watermark ?? { applied: "none", reason: "runtime-without-watermark" },
      output_hash: id.replace(/-/g, "").padEnd(64, "0"), hash_key_version: 1,
    };
    this.receipts.push(receipt);
    return { value: { receipt, signature: fakeJws(receipt) }, id };
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
      model: agent.model ?? "fake-model", ...(agent.vision !== undefined ? { vision: agent.vision } : {}), images: false,
      skills: agent.skills !== undefined, instructions_sha256: "0".repeat(64),
      host_tool_contract: agent.contract ?? [], server_tools: null, knowledge: [],
      local_mcp: { mode: agent.localMcpMode ?? "disable", developer_mode: user.developerMode ?? false },
      tool_modes: { default: "ask", ceiling: agent.ceiling ?? null, open_world_enforced: false },
      ui: agent.ui ?? {}, extensions: {}, required_client_modules: agent.requiredClientModules ?? [],
      edition: "community", features: ["agents"], user: { language: user.language ?? null },
    };
  }

  /** `GET /v1/agents/{agent}/skills`: the agent's skills, `q` matching name, slug or description; `limit` at most 100. */
  #skills(slug: string, url: URL): Record<string, unknown> {
    const skills = this.#agents.get(slug)!.skills;
    if (skills === undefined) return { object: "list", available: false, data: [] };
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    const data = skills
      .filter((s) => !q || [s.slug, s.name ?? "", s.description ?? ""].some((t) => t.toLowerCase().includes(q)))
      .slice(0, limit)
      .map((s) => ({ id: `skill-${s.slug}`, slug: s.slug, name: s.name ?? s.slug, description: s.description ?? "", activation: s.activation ?? "manual" }));
    return { object: "list", available: true, data };
  }

  /** The language a user picked for every client, as the server keeps it. */
  languageOf(email: string): string | null {
    return this.#users.find((u) => u.email === email)?.language ?? null;
  }

  /** `PATCH /v1/agents/{agent}/user`: a language tag, or null to forget it; a body without it changes nothing. */
  #userSettings(signIn: SignIn, body: unknown): Response {
    const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const language = b?.["language"];
    const tag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
    if (!b || Object.keys(b).some((k) => k !== "language") || (language !== undefined && language !== null &&
        (typeof language !== "string" || !tag.test(language)))) {
      return openAiError(400, "language must be a language tag such as de, de-AT or zh-Hans, or null.", "invalid_language", "invalid_request_error");
    }
    const user = this.#users.find((u) => u.id === signIn.userId)!;
    if (language !== undefined) user.language = language as string | null;
    return json(200, { object: "agent.user", language: user.language ?? null });
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
    const receipt = this.#receipt(reply, agent);
    const response = modelRequest.stream ? this.#stream(reply, events, screen, receipt?.value) : this.#whole(reply, events, screen);
    if (held.length) response.headers.set("x-faden-held-tools", held.map((t) => t.name).sort().join(","));
    // As the gateway does: an answer that was not streamed names its receipt in a header.
    if (!modelRequest.stream && receipt?.id) response.headers.set(RECEIPT_HEADER, receipt.id);
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
      choices: [{ index: 0, message, finish_reason: reply.refuse ? "content_filter" : reply.finish ?? (calls.length ? "tool_calls" : "stop") }],
      usage: usage(reply),
    };
    const faden: Record<string, unknown> = {};
    const all = [...(reply.events ?? []), ...screen(calls)];
    if (events && all.length) faden["events"] = all;
    if (reply.refuse?.stage === "output") faden["governance"] = this.#governance("response_blocked", "output", reply.refuse);
    if (Object.keys(faden).length) out["faden"] = faden;
    return json(200, out);
  }

  #stream(reply: FakeReply, events: boolean, screen: (calls: WireCall[]) => Record<string, unknown>[],
    receipt: Record<string, unknown> | undefined): Response {
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
            await send(chunk({}, reply.finish ?? (calls.length ? "tool_calls" : "stop")));
          }
          await send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fake-model", choices: [], usage: usage(reply) })}\n\n`);
          // The receipt comes last, as the stream closes, before [DONE].
          if (receipt) await send(faden({ type: "CUSTOM", name: "faden.provenance", value: receipt }));
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

/** What is wrong with a placement report for the server (it forbids extra fields), or undefined. */
function placementProblem(body: unknown): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields = ["record_id", "tool", "sink_kind", "media_type", "edit_kind", "length_class", "layers"];
  const extra = Object.keys(b).filter((k) => !fields.includes(k));
  if (extra.length) return `extra fields not permitted: ${extra.join(", ")}`;
  // record_id is optional: exempt content, an unsigned record and unmarked content have none.
  const missing = fields.filter((k) => k !== "record_id" && (b[k] === undefined || b[k] === null));
  if (missing.length) return `required: ${missing.join(", ")}`;
  if (["tool", "sink_kind", "media_type"].some((k) => typeof b[k] !== "string" || !b[k])) return "names are strings";
  const recordId = b["record_id"];
  if (recordId !== undefined && recordId !== null && (typeof recordId !== "string" || recordId.length > 128)) {
    return "record_id is a string of 128 characters at most";
  }
  if (!isEditKind(b["edit_kind"])) return "edit_kind is not an edit kind";
  if (!["short", "medium", "long"].includes(b["length_class"] as string)) return "length_class is short, medium or long";
  if (!Array.isArray(b["layers"])) return "layers is a list";
  if ((b["layers"] as unknown[]).length > 32) return "32 layers at most";
  for (const layer of b["layers"] as Record<string, unknown>[]) {
    const extraLayer = Object.keys(layer ?? {}).filter((k) => !["layer", "method", "applied", "reason", "verified"].includes(k));
    if (extraLayer.length) return `extra fields not permitted in a layer: ${extraLayer.join(", ")}`;
    if (!(MARK_LAYERS as readonly unknown[]).includes(layer["layer"])) return "a layer is metadata, watermark, fingerprint or label";
    if (typeof layer["method"] !== "string" || typeof layer["applied"] !== "boolean") return "a layer has a method and applied";
    if ((layer["method"] as string).length > 64) return "a layer's method is 64 characters at most";
    const reason = layer["reason"];
    if (reason !== undefined && reason !== null && !(REASON_CODES as readonly unknown[]).includes(reason)) return `not a reason code: ${String(reason)}`;
    const verified = layer["verified"];
    if (verified !== undefined && verified !== null && typeof verified !== "boolean") return "a layer's verified is true, false or absent";
  }
  return undefined;
}

/** The fake's keyed hash of a content hash: what the server keeps instead of the content's own hash. */
async function keyedHash(contentSha256: string): Promise<string> {
  return textSha256(`fake-hash-key:${contentSha256}`);
}

/** A JWS in the server's shape (ES256 header, the canonical JSON payload) with a signature nobody can check. */
function fakeJws(payload: unknown): string {
  const header = { alg: "ES256", typ: "faden-provenance+jws", kid: "fake-1" };
  return [canonical(header), canonical(payload), "fake signature"].map(base64Url).join(".");
}

/** JSON with sorted keys and no spaces, as the server signs it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Not a certificate: what the fake's anchors list in place of one. */
const FAKE_CERTIFICATE = "-----BEGIN CERTIFICATE-----\nZmFrZSBjZXJ0aWZpY2F0ZQ==\n-----END CERTIFICATE-----\n";

/** A tool rule's pattern: `*` stands for any characters, everything else for itself (fnmatch, as the gateway). */
function globMatch(pattern: string, name: string): boolean {
  const parts = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(name);
}
