import { FadenstackApiError, FadenstackError } from "../errors.js";
import { jsonRequest, type FadenstackTransport } from "../http/transport.js";
import { toApiError } from "../http/errorReader.js";
import { toWireManifest, type AppManifest } from "../manifest.js";
import { toAgentPrincipal, toAgentProfile, toSkillList, toWireEvent, type AgentClientEvent, type AgentPrincipal, type AgentProfile, type SkillList, type AnswerScope } from "../models.js";
import type { ToolClass, ToolMode } from "../tools/toolModes.js";
import { AgentProvenanceResource } from "./provenance.js";
import { grantObject, grantString, grantNumber, toAgentGrant, toWireGrant,
  type GrantRequest, type GrantExtension, type AgentGrant, type GrantList, type GrantReport, type StepUpStarted, type StepUpPoll } from "../grants.js";

/** The server takes at most this many events per report. */
export const MAX_EVENTS_PER_REPORT = 100;
export const HOST_TOOL_DISPATCH_FEATURE = "host_tools.dispatch_check";

export interface HostToolCheck {
  name: string;
  arguments: Record<string, unknown>;
  toolMode: ToolMode;
  origin: "user_command" | "user_history" | "model_tool";
  /** Required for model calls; binds audit attribution across preparation and dispatch. */
  callId?: string;
  phase: "prepare" | "dispatch";
  schemaSha256: string;
  prepared?: Pick<HostToolDecision, "profileStamp" | "argumentsStamp" | "decisionStamp">;
  conversationId: string;
  turnId: string;
}

export interface HostToolDecision {
  decision: "deny" | "ask" | "run";
  toolClass: ToolClass;
  effectiveToolMode: ToolMode;
  requiredByRule: boolean;
  message: string;
  profileStamp: string;
  argumentsStamp: string;
  decisionStamp: string;
  principal: AgentPrincipal;
}

/** The client's agent: its profile, the events the SDK reports, and approvals the gateway waits for. */
export class AgentResource {
  readonly agent: string;
  /** The agent's provenance routes: its marking policy, signed records of placements, placement reports. */
  readonly provenance: AgentProvenanceResource;
  readonly #transport: FadenstackTransport;

  constructor(transport: FadenstackTransport, agent: string) {
    this.#transport = transport;
    this.agent = agent;
    this.provenance = new AgentProvenanceResource(transport, agent);
  }

  #route(rest: string): URL {
    return this.#transport.gateway(`v1/agents/${encodeURIComponent(this.agent)}/${rest}`);
  }

  /** The agent's current version: model, tool contract, local MCP mode, tool modes; never its instructions. */
  async getProfile(signal?: AbortSignal): Promise<AgentProfile> {
    return toAgentProfile(await this.#transport.get<unknown>(this.#route("profile"), signal));
  }

  /** Current policy for a device's explicit user command. Never invokes a native/gateway tool or a model. */
  async checkHostTool(check: HostToolCheck, signal?: AbortSignal): Promise<HostToolDecision> {
    const body = {
      name: check.name, arguments: check.arguments, tool_mode: check.toolMode, origin: check.origin,
      ...(check.callId !== undefined ? { call_id: check.callId } : {}),
      phase: check.phase, schema_sha256: check.schemaSha256,
      ...(check.prepared ? { prepared_profile: check.prepared.profileStamp,
        prepared_arguments: check.prepared.argumentsStamp, prepared_decision: check.prepared.decisionStamp } : {}),
    };
    const { response, text } = await this.#transport.request(() => {
      const spec = jsonRequest("POST", this.#route("tools/check"), body);
      return { ...spec, headers: { ...spec.headers,
        "x-faden-conversation-id": check.conversationId, "x-faden-turn-id": check.turnId } };
    }, signal);
    if (!response.ok) throw toApiError(response, text);
    const p = JSON.parse(text) as Record<string, unknown>;
    const principal = toAgentPrincipal(p["principal"]);
    const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (!["deny", "ask", "run"].includes(String(p["decision"]))
      || !["read", "write", "destructive", "unknown"].includes(String(p["tool_class"]))
      || !["off", "read_only", "ask", "auto"].includes(String(p["effective_tool_mode"]))
      || !digest(p["profile_stamp"]) || !digest(p["arguments_stamp"]) || !digest(p["decision_stamp"])
      || typeof p["required_by_rule"] !== "boolean" || typeof p["message"] !== "string" || !principal) {
      throw new FadenstackError("The gateway did not return a valid host-command policy decision.");
    }
    return { decision: p["decision"] as HostToolDecision["decision"], toolClass: p["tool_class"] as ToolClass,
      effectiveToolMode: p["effective_tool_mode"] as ToolMode, requiredByRule: p["required_by_rule"], message: p["message"],
      profileStamp: p["profile_stamp"], argumentsStamp: p["arguments_stamp"], decisionStamp: p["decision_stamp"], principal };
  }

  /** Reports what the SDK did -- names, counts, outcomes. Up to 100 per call. */
  async report(events: readonly AgentClientEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return;
    if (events.length > MAX_EVENTS_PER_REPORT) {
      throw new RangeError(`At most ${MAX_EVENTS_PER_REPORT} events per report.`);
    }
    await this.#transport.post<unknown>(this.#route("events"), { events: events.map(toWireEvent) }, signal);
  }

  /**
   * Tells the server what the app brings -- its tools with their classes, its context, its greeting -- for its
   * admins to review. The same manifest again is only counted (`isNew` false).
   */
  async reportManifest(manifest: AppManifest, signal?: AbortSignal): Promise<{ sha256: string; isNew: boolean }> {
    const answer = await this.#transport.json<{ sha256?: string; new?: boolean }>(
      "PUT", this.#route("manifest"), toWireManifest(manifest), signal,
    );
    return { sha256: String(answer?.sha256 ?? ""), isNew: Boolean(answer?.new) };
  }

  /**
   * Keeps the language the user picked (a BCP 47 tag such as `de` or `zh-Hans`) for all their clients and the
   * console; null forgets it, so each client follows its host. Returns the language kept. An older server, without
   * the route, answers 404.
   */
  async setUserLanguage(language: string | null, signal?: AbortSignal): Promise<string | null> {
    const answer = await this.#transport.patch<{ language?: unknown }>(this.#route("user"), { language }, signal);
    return typeof answer?.language === "string" && answer.language ? answer.language : null;
  }

  /**
   * The skills the signed-in user can pick for a message in this agent's chats (they go as `ChatOptions.skills`):
   * the ones a chat could be given, `query` narrowing them by name or description. A server without skills, or an
   * older one without the route, offers none (`available` false).
   */
  async listSkills(options: { query?: string; limit?: number; signal?: AbortSignal } = {}): Promise<SkillList> {
    const url = this.#route("skills");
    if (options.query?.trim()) url.searchParams.set("q", options.query.trim().slice(0, 200));
    if (options.limit !== undefined) url.searchParams.set("limit", String(Math.max(1, Math.min(100, Math.floor(options.limit)))));
    try {
      return toSkillList(await this.#transport.get<unknown>(url, options.signal));
    } catch (error) {
      if (error instanceof FadenstackApiError && error.status === 404 && error.code !== "agent_not_found") {
        return { available: false, skills: [] };
      }
      throw error;
    }
  }

  /** Approves or declines a gateway tool call waiting for the user (`faden.approval_required`). */
  answerApproval(approvalId: string, approved: boolean, signal?: AbortSignal): Promise<void>;
  answerApproval(approvalId: string, approved: boolean, scope: AnswerScope, signal?: AbortSignal): Promise<void>;
  async answerApproval(approvalId: string, approved: boolean, scopeOrSignal?: AnswerScope | AbortSignal, signal?: AbortSignal): Promise<void> {
    const scope = typeof scopeOrSignal === "string" ? scopeOrSignal : undefined;
    if (scope !== undefined && !["once", "chat", "always"].includes(scope)) throw new TypeError("Invalid approval answer scope.");
    await this.#transport.post<unknown>(this.#route(`approvals/${encodeURIComponent(approvalId)}`),
      { approved, ...(scope !== undefined ? { scope } : {}) }, typeof scopeOrSignal === "string" ? signal : scopeOrSignal);
  }

  /** The person's confirmed request; only the returned server scope holds. Never create a grant automatically. */
  async createGrant(request: GrantRequest, options: { conversationId?: string; stepUpProof?: string; signal?: AbortSignal } = {}): Promise<AgentGrant> {
    return toAgentGrant(await this.#grantRequest("POST", "grants", toWireGrant(request), options));
  }

  async listGrants(signal?: AbortSignal): Promise<GrantList> {
    const value = grantObject(await this.#transport.get<unknown>(this.#route("grants"), signal));
    const serverNow = grantString(value["server_now"]);
    if (!Array.isArray(value["data"])) throw new FadenstackError("Invalid grant list.");
    return { data: value["data"].map(v => toAgentGrant(v, serverNow)), serverNow };
  }

  async getGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return toAgentGrant(await this.#transport.get<unknown>(this.#route(`grants/${encodeURIComponent(id)}`), signal));
  }

  async revokeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return toAgentGrant(await this.#transport.json<unknown>("DELETE", this.#route(`grants/${encodeURIComponent(id)}`), undefined, signal));
  }

  async pauseGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return toAgentGrant(await this.#transport.post<unknown>(this.#route(`grants/${encodeURIComponent(id)}/pause`), {}, signal));
  }

  async resumeGrant(id: string, signal?: AbortSignal): Promise<AgentGrant> {
    return toAgentGrant(await this.#transport.post<unknown>(this.#route(`grants/${encodeURIComponent(id)}/resume`), {}, signal));
  }

  async extendGrant(id: string, extension: GrantExtension, signal?: AbortSignal): Promise<AgentGrant> {
    return toAgentGrant(await this.#transport.post<unknown>(this.#route(`grants/${encodeURIComponent(id)}/extend`), {
      ...(extension.minutes !== undefined ? { minutes: extension.minutes } : {}), ...(extension.targets !== undefined ? { targets: extension.targets } : {}),
      ...(extension.shownTextSha256 !== undefined ? { shown_text_sha256: extension.shownTextSha256 } : {}),
    }, signal));
  }

  async reportGrant(id: string, calls: readonly string[], signal?: AbortSignal): Promise<GrantReport> {
    const value = grantObject(await this.#transport.post<unknown>(this.#route(`grants/${encodeURIComponent(id)}/report`), { calls }, signal));
    return { matched: grantNumber(value["matched"]), deviceOnly: grantNumber(value["device_only"]), gatewayOnly: grantNumber(value["gateway_only"]) };
  }

  /** Codes and proofs are memory-only; the host opens the verified same-server sign-in page. */
  async startStepUp(longestMinutes?: number, clientVersion?: string, signal?: AbortSignal): Promise<StepUpStarted> {
    const value = grantObject(await this.#transport.post<unknown>(this.#transport.api("api/agent-tokens/step-ups"),
      { ...(longestMinutes !== undefined ? { longest_minutes: longestMinutes } : {}), ...(clientVersion !== undefined ? { client_version: clientVersion } : {}) }, signal));
    const uri = grantString(value["verification_uri"]), complete = grantString(value["verification_uri_complete"]);
    // A malformed/compromised response cannot redirect the second sign-in to another origin.
    if (new URL(uri).origin !== this.#transport.apiUrl.origin || new URL(complete).origin !== this.#transport.apiUrl.origin)
      throw new FadenstackError("The step-up sign-in origin changed.");
    const interval = grantNumber(value["interval"]), expiresIn = grantNumber(value["expires_in"]);
    if (!interval || !expiresIn) throw new FadenstackError("Invalid step-up timing.");
    return { stepUpCode: grantString(value["step_up_code"]), userCode: grantString(value["user_code"]), verificationUri: uri,
      verificationUriComplete: complete, expiresIn, interval };
  }

  async pollStepUp(stepUpCode: string, signal?: AbortSignal): Promise<StepUpPoll> {
    const { response, text } = await this.#transport.request(() => jsonRequest("POST", this.#transport.api("api/agent-tokens/step-ups/token"), { step_up_code: stepUpCode }), signal);
    if (!response.ok) {
      if (response.status === 400) {
        const value = grantObject(JSON.parse(text));
        const error = value["error"];
        if (["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant"].includes(String(error)))
          return { error: error as Extract<StepUpPoll, { error: string }>["error"], ...(value["interval"] === undefined ? {} : { interval: grantNumber(value["interval"]) }) };
      }
      throw toApiError(response, text);
    }
    const value = grantObject(JSON.parse(text));
    return { proof: grantString(value["proof"]), expiresIn: grantNumber(value["expires_in"]), signedInAt: grantString(value["signed_in_at"]), method: grantString(value["method"]) };
  }

  async #grantRequest(method: string, rest: string, body: unknown, options: { conversationId?: string; stepUpProof?: string; signal?: AbortSignal }): Promise<unknown> {
    const { response, text } = await this.#transport.request(() => {
      const spec = jsonRequest(method, this.#route(rest), body);
      return { ...spec, headers: { ...spec.headers,
        ...(options.conversationId !== undefined ? { "x-faden-conversation-id": options.conversationId } : {}),
        ...(options.stepUpProof !== undefined ? { "x-faden-step-up": options.stepUpProof } : {}),
      } };
    }, options.signal);
    if (!response.ok) throw toApiError(response, text);
    return JSON.parse(text) as unknown;
  }
}
