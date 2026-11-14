import type { AgentProfile } from "@fadenstack/client";
import type { MachinePolicy } from "@fadenstack/agents";

/** Whether a local server may be attached, and why not (shown to the person). .NET: `LocalMcpDecision`. */
export interface LocalMcpDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Decides which local MCP servers an agent may attach. The core policy knows the profile's modes `disable` (the default) and `allow`,
 * the user's developer mode, and the machine policy's `mcp`. An extension with further modes replaces it with its own; local
 * configuration can only tighten this, never widen it. .NET: `ILocalMcpPolicy`.
 */
export interface LocalMcpPolicy {
  decide(server: { readonly label: string; readonly url: string }, profile: AgentProfile, machinePolicy: MachinePolicy): LocalMcpDecision;
}

/**
 * The core rule (sdk/51 F05, "Policy"):
 * - governed: the profile's `local_mcp.mode` is `allow`, or the user's developer mode is on; absent or unknown means off;
 * - standalone: the profile says `allow` unless the person switched local MCP off (the person's settings), and the machine policy
 *   (`mcp`) comes first: `forbidden` turns every server off, and a list allows only the servers whose source it names: the
 *   address, its origin, or the address without a final slash (`mcpSourceNames`). A label is the person's own word, so it is
 *   never a source (as .NET's `McpSources`, which also takes a program's path; a browser starts none);
 * - a server that was imported arrives off, whatever the policy says (the person switches each on; `McpServerRecord.enabled`).
 * .NET: `CoreLocalMcpPolicy` with `McpSources.Decide`.
 */
/** The names a machine policy's `mcp` list can name a server by: its address, its origin, the address without a final slash. */
export function mcpSourceNames(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  return [...new Set([parsed.href, parsed.origin, parsed.href.replace(/\/+$/, "")])];
}

export const coreLocalMcpPolicy: LocalMcpPolicy = Object.freeze({
  decide(server: { readonly label: string; readonly url: string }, profile: AgentProfile, machinePolicy: MachinePolicy): LocalMcpDecision {
    if (!mcpSourceNames(server.url).some((name) => machinePolicy.mcp.allows(name))) {
      return { allowed: false, reason: machinePolicy.mcp.allowsAny ? "The machine policy does not list this MCP source." : "The machine policy does not allow local MCP servers." };
    }
    const settings = profile.localMcp;
    const mode = settings?.mode;
    if (mode === "allow") return { allowed: true, reason: "The agent allows local MCP servers." };
    if (settings?.developerMode === true) return { allowed: true, reason: "Developer mode." };
    if (mode === undefined || mode === "" || mode === "disable") return { allowed: false, reason: "The agent does not allow local MCP servers." };
    return { allowed: false, reason: `The agent's local MCP mode '${mode}' needs a policy this app does not have.` };
  },
});
