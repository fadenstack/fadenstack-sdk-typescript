import { parseToolMode, type ToolMode } from "./tools/toolModes.js";

/** What the SDK caches about its agent (`GET /v1/agents/{agent}/profile`): never its instructions. */
export interface AgentProfile {
  id: string;
  slug: string;
  name: string;
  version: number | null;
  /** A maintainer's draft, not the published version. */
  draft: boolean;
  model: string | null;
  instructionsSha256: string | null;
  /** The tools the host application may offer; any other tool is refused. Empty: no restriction. */
  hostToolContract: ToolContractEntry[];
  /** The gateway's own tools the model may be offered; null: what a chat gets. */
  serverTools: string[] | null;
  knowledge: string[];
  localMcp: { mode: string; developerMode: boolean };
  toolModes: { default: ToolMode; ceiling: ToolMode | null; openWorldEnforced: boolean };
  /** What the SDKs show: `greeting`, `suggestions`. */
  ui: Record<string, unknown>;
  extensions: Record<string, unknown>;
  /** SDK modules the agent needs (e.g. `pii.local`, EE); the SDK refuses to run without them. */
  requiredClientModules: string[];
  edition: string;
  features: string[];
}

/** One tool of an agent's host tool contract. */
export interface ToolContractEntry {
  name: string;
  /** `read`, `write` or `destructive`: the tool's class. Absent: unknown. */
  risk?: string;
  schemaSha256?: string;
  approval?: string;
}

/** `GET /v1/features`: the server's edition and features. */
export interface ServerFeatures {
  edition: string;
  features: string[];
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The profile from the gateway's snake_case JSON. */
export function toAgentProfile(json: unknown): AgentProfile {
  const p = obj(json);
  const localMcp = obj(p["local_mcp"]);
  const modes = obj(p["tool_modes"]);
  return {
    id: str(p["id"]) ?? "",
    slug: str(p["slug"]) ?? "",
    name: str(p["name"]) ?? str(p["slug"]) ?? "",
    version: typeof p["version"] === "number" ? (p["version"] as number) : null,
    draft: p["draft"] === true,
    model: str(p["model"]) ?? null,
    instructionsSha256: str(p["instructions_sha256"]) ?? null,
    hostToolContract: Array.isArray(p["host_tool_contract"])
      ? (p["host_tool_contract"] as unknown[]).map((e) => {
          const t = obj(e);
          const entry: ToolContractEntry = { name: str(t["name"]) ?? "" };
          const risk = str(t["risk"]);
          const sha = str(t["schema_sha256"]);
          const approval = str(t["approval"]);
          if (risk !== undefined) entry.risk = risk;
          if (sha !== undefined) entry.schemaSha256 = sha;
          if (approval !== undefined) entry.approval = approval;
          return entry;
        })
      : [],
    serverTools: Array.isArray(p["server_tools"]) ? strings(p["server_tools"]) : null,
    knowledge: strings(p["knowledge"]),
    localMcp: { mode: str(localMcp["mode"]) ?? "disable", developerMode: localMcp["developer_mode"] === true },
    toolModes: {
      default: parseToolMode(str(modes["default"])) ?? "ask",
      ceiling: parseToolMode(str(modes["ceiling"])) ?? null,
      openWorldEnforced: modes["open_world_enforced"] === true,
    },
    ui: obj(p["ui"]),
    extensions: obj(p["extensions"]),
    requiredClientModules: strings(p["required_client_modules"]),
    edition: str(p["edition"]) ?? "community",
    features: strings(p["features"]),
  };
}

/**
 * What the SDK reports about its work (02 §9, 06 §5): names, counts, durations, outcomes -- never arguments,
 * results or messages. The server refuses any other field.
 */
export type AgentClientEvent =
  | ToolExecutedEvent
  | ApprovalDecidedEvent
  | LocalMcpAttachedEvent
  | SessionStatsEvent;

interface ClientEventBase {
  /** When it happened (default: when it was reported). */
  occurredAt?: Date;
  conversationId?: string;
}

/** A tool ran on the device. */
export interface ToolExecutedEvent extends ClientEventBase {
  type: "tool.executed";
  tool: string;
  /** `host`, `mcp` or `gateway`. */
  source?: "host" | "mcp" | "gateway";
  server?: string;
  durationMs: number;
  outcome: "ok" | "error" | "denied" | "cancelled";
}

/** A call that needed approval was decided: by the user, or by an approval that stood (this chat, always, bypass mode). */
export interface ApprovalDecidedEvent extends ClientEventBase {
  type: "approval.decided";
  tool: string;
  decision: "approved" | "denied" | "timeout";
  /** How long the user took; not given when nobody was asked. */
  waitMs?: number;
  /** What let an approved call through: the user once, this chat, always on this device, or bypass mode. */
  scope?: "once" | "chat" | "always" | "bypass";
}

/** A local MCP server was attached, and the tools it offers. */
export interface LocalMcpAttachedEvent extends ClientEventBase {
  type: "local_mcp.attached";
  label: string;
  command?: string;
  url?: string;
  tools: string[];
}

/** Counts of one local session. */
export interface SessionStatsEvent extends ClientEventBase {
  type: "session.stats";
  turns: number;
  compactions?: number;
  retentionSessions?: number;
  retentionDays?: number;
}

/** An event in the server's snake_case shape, without the fields that are not set. */
export function toWireEvent(event: AgentClientEvent): Record<string, unknown> {
  const wire: Record<string, unknown> = { type: event.type };
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) wire[key] = value;
  };
  put("occurred_at", (event.occurredAt ?? new Date()).toISOString());
  put("conversation_id", event.conversationId);
  switch (event.type) {
    case "tool.executed":
      put("tool", event.tool);
      put("source", event.source);
      put("server", event.server);
      put("duration_ms", Math.max(0, Math.round(event.durationMs)));
      put("outcome", event.outcome);
      break;
    case "approval.decided":
      put("tool", event.tool);
      put("decision", event.decision);
      put("wait_ms", event.waitMs === undefined ? undefined : Math.max(0, Math.round(event.waitMs)));
      put("scope", event.scope);
      break;
    case "local_mcp.attached":
      put("label", event.label);
      put("command", event.command);
      put("url", event.url);
      put("tools", event.tools);
      break;
    case "session.stats":
      put("turns", event.turns);
      put("compactions", event.compactions ?? 0);
      put("retention_sessions", event.retentionSessions);
      put("retention_days", event.retentionDays);
      break;
  }
  return wire;
}
