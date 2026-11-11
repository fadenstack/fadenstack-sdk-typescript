import { FadenstackError } from "./errors.js";
import type { ToolClass } from "./tools/toolModes.js";

export interface GrantTarget {
  type: "document" | "folder" | "site" | "app" | "desk";
  identifiers: string[];
  actions?: ("read" | "write")[] | null;
}
export interface GrantRequest {
  kind: "time" | "work" | "bypass";
  minutes: number;
  tools?: string[];
  classes?: ("read" | "write")[];
  targets?: GrantTarget[];
  maxCalls?: number;
  conversation?: boolean;
  shownTextSha256?: string;
  reason?: string;
  clientVersion?: string;
}
export interface GrantExtension { minutes?: number; targets?: GrantTarget[]; shownTextSha256?: string }
export interface GrantScope { tools?: string[]; classes?: ToolClass[]; targets?: GrantTarget[] }
export interface GrantStepUp { method: string; provider: string | null; at: string | null }
export interface AgentGrant {
  id: string;
  kind: "time" | "work" | "bypass";
  status: "active" | "paused" | "revoked" | "expired" | "spent";
  agentId: string;
  agentVersion: number;
  deviceId: string;
  conversationId: string | null;
  scope: GrantScope;
  issuedAt: string | null;
  expiresAt: string;
  /** Display only: freshness/permission must always be checked with the server. */
  remainingS: number;
  maxCalls: number | null;
  callsUsed: number;
  pausedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  evidenceLevel: "decisions" | "calls" | "results";
  stepUp: GrantStepUp | null;
  serverNow: string;
  narrowed: string[];
}
export interface GrantList { data: AgentGrant[]; serverNow: string }
export interface GrantReport { matched: number; deviceOnly: number; gatewayOnly: number }
export interface StepUpStarted {
  /** In-memory only. Never log or persist. */
  stepUpCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
export interface StepUpProof { proof: string; expiresIn: number; signedInAt: string; method: string }
/** The named equivalent of .NET's (Proof, Error, Interval) polling result. */
export interface StepUpPoll {
  proof: StepUpProof | null;
  error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" | null;
  interval: number | null;
}

type Json = Record<string, unknown>;
export const grantObject = (v: unknown): Json => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new FadenstackError("Invalid grant response.");
  return v as Json;
};
export const grantString = (v: unknown): string => {
  if (typeof v !== "string" || !v) throw new FadenstackError("Invalid grant response.");
  return v;
};
export const grantNumber = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new FadenstackError("Invalid grant response.");
  return v;
};
const nullable = (v: unknown): string | null => v === null ? null : grantString(v);
const date = (v: unknown): string => {
  const s = grantString(v);
  if (!Number.isFinite(Date.parse(s))) throw new FadenstackError("Invalid grant response timestamp.");
  return s;
};
const nullableDate = (v: unknown): string | null => v === null ? null : date(v);
function member<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new FadenstackError("Invalid grant response enum.");
  return v as T;
}
function list(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every(x => typeof x === "string" && x.length > 0)) throw new FadenstackError("Invalid grant response list.");
  return [...v] as string[];
}
function targets(v: unknown): GrantTarget[] {
  if (!Array.isArray(v)) throw new FadenstackError("Invalid grant targets.");
  return v.map(raw => {
    const t = grantObject(raw), identifiers = list(t["identifiers"]);
    if (!identifiers.length) throw new FadenstackError("Invalid grant targets.");
    return { type: member(t["type"], ["document", "folder", "site", "app", "desk"]), identifiers,
      ...(t["actions"] === undefined ? {} : { actions: t["actions"] === null ? null : list(t["actions"]).map(x => member(x, ["read", "write"])) }) };
  });
}

/** A response is data, not a native-access permit. Reject malformed authority, never default to active. */
export function toAgentGrant(value: unknown, serverNow?: string): AgentGrant {
  const g = grantObject(value), scope = grantObject(g["scope"]);
  const step = g["step_up"] == null ? null : grantObject(g["step_up"]);
  const kind = member(g["kind"], ["time", "work", "bypass"]);
  const parsedScope: AgentGrant["scope"] = {
    ...(scope["tools"] === undefined ? {} : { tools: list(scope["tools"]) }),
    ...(scope["classes"] === undefined ? {} : { classes: list(scope["classes"]).map(x => member(x, ["read", "write", "destructive", "unknown"])) }),
    ...(scope["targets"] === undefined ? {} : { targets: targets(scope["targets"]) }),
  };
  if (kind === "time" && !parsedScope.tools?.length || kind === "work" && (!parsedScope.targets?.length || !parsedScope.classes?.length)
    || kind === "bypass" && !parsedScope.classes?.length) throw new FadenstackError("Invalid grant scope.");
  return { id: grantString(g["id"]), kind, status: member(g["status"], ["active", "paused", "revoked", "expired", "spent"]),
    agentId: grantString(g["agent_id"]), agentVersion: grantNumber(g["agent_version"]), deviceId: grantString(g["device_id"]),
    conversationId: nullable(g["conversation_id"]), scope: parsedScope, issuedAt: nullableDate(g["issued_at"]), expiresAt: date(g["expires_at"]),
    remainingS: grantNumber(g["remaining_s"]), maxCalls: g["max_calls"] === null ? null : grantNumber(g["max_calls"]), callsUsed: grantNumber(g["calls_used"]),
    pausedAt: nullableDate(g["paused_at"]), revokedAt: nullableDate(g["revoked_at"]), revokedBy: nullable(g["revoked_by"]),
    evidenceLevel: member(g["evidence_level"], ["decisions", "calls", "results"]),
    stepUp: step ? { method: grantString(step["method"]), provider: nullable(step["provider"]), at: nullableDate(step["at"]) } : null,
    serverNow: date(serverNow ?? g["server_now"]), narrowed: g["narrowed"] === undefined ? [] : list(g["narrowed"]) };
}

/**
 * A list from the server. A grant this SDK cannot read -- a later kind, status or evidence level, or a malformed one --
 * is left out: it covers nothing here. The others stand, so one new value does not take every grant away.
 */
export function toAgentGrants(values: readonly unknown[], serverNow: string): AgentGrant[] {
  const grants: AgentGrant[] = [];
  for (const value of values) {
    try {
      grants.push(toAgentGrant(value, serverNow));
    } catch {
      // left out, as above
    }
  }
  return grants;
}

export function toWireGrant(request: GrantRequest): Json {
  return { kind: request.kind, minutes: request.minutes, ...(request.tools !== undefined ? { tools: request.tools } : {}),
    ...(request.classes !== undefined ? { classes: request.classes } : {}), ...(request.targets !== undefined ? { targets: request.targets } : {}),
    ...(request.maxCalls !== undefined ? { max_calls: request.maxCalls } : {}), ...(request.conversation !== undefined ? { conversation: request.conversation } : {}),
    ...(request.shownTextSha256 !== undefined ? { shown_text_sha256: request.shownTextSha256 } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}), ...(request.clientVersion !== undefined ? { client_version: request.clientVersion } : {}) };
}
