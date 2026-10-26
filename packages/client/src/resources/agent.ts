import { FadenstackApiError, FadenstackError } from "../errors.js";
import { jsonRequest, type FadenstackTransport } from "../http/transport.js";
import { toApiError } from "../http/errorReader.js";
import { toWireManifest, type AppManifest } from "../manifest.js";
import { toAgentPrincipal, toAgentProfile, toSkillList, toWireEvent, type AgentClientEvent, type AgentPrincipal, type AgentProfile, type SkillList } from "../models.js";
import type { ToolClass, ToolMode } from "../tools/toolModes.js";
import { AgentProvenanceResource } from "./provenance.js";

/** The server takes at most this many events per report. */
export const MAX_EVENTS_PER_REPORT = 100;

export interface HostToolCheck {
  name: string;
  arguments: Record<string, unknown>;
  toolMode: ToolMode;
  origin: "user_command" | "user_history";
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
  async answerApproval(approvalId: string, approved: boolean, signal?: AbortSignal): Promise<void> {
    await this.#transport.post<unknown>(this.#route(`approvals/${encodeURIComponent(approvalId)}`), { approved }, signal);
  }
}
