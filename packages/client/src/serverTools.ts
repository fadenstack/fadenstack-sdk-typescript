/**
 * A tool of one of the organisation's MCP servers, as the agent's server lists it for the signed-in user
 * (`AgentResource.listTools`): names and descriptions only, never how the server is reached. .NET: `AgentToolInfo`.
 */
export interface AgentToolInfo {
  /** The name the model calls it by, such as `mcp.github.search`. */
  name: string;
  /** The MCP server that brings it. */
  server: string;
  description: string;
  /** Whether this agent's tool rules let its requests be offered and run the tool. Anything but `true` reads as no. */
  allowed: boolean;
  /** Whether the tool is switched on (an administrator may have switched it off). Anything but `true` reads as no. */
  enabled: boolean;
}

/** The list `GET /v1/agents/{agent}/tools` sends (`{"tools":[...]}`); never throws on what a server wrote, an entry without a name is left out. */
export function toAgentToolList(wire: unknown): AgentToolInfo[] {
  const list = wire !== null && typeof wire === "object" ? (wire as Record<string, unknown>)["tools"] : undefined;
  if (!Array.isArray(list)) return [];
  const tools: AgentToolInfo[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["name"] !== "string" || !e["name"]) continue;
    tools.push({
      name: e["name"], server: typeof e["server"] === "string" ? e["server"] : "",
      description: typeof e["description"] === "string" ? e["description"] : "",
      allowed: e["allowed"] === true, enabled: e["enabled"] === true,
    });
  }
  return tools;
}
