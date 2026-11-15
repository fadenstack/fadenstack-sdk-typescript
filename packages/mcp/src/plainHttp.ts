import { PolicyAccess, type AgentContext } from "@fadenstack/agents";
import { hostScope } from "@fadenstack/client";

import { McpError } from "./errors.js";

/**
 * Why plain http to an MCP server was refused (sdk/51 F05). An app shows its own words for each. .NET: `McpPlainHttpRefusal`.
 * - `noOptIn`: the address is beyond this computer and the person has not switched on "Allow plain http on the local network";
 * - `notLocal`: the switch is on, but the host is not on the local network (by its spelling: a browser cannot resolve names);
 * - `secret`: the server is sent a header value (a token), which plain http carries only to `localhost`, `127.0.0.1` or `::1`;
 * - `notAllowed`: the agent's profile (`local_mcp.plain_http` not `allow`) or this computer's policy (`plainHttp: forbidden`)
 *   does not allow plain http on the local network: "Plain http is not allowed here".
 */
export type McpPlainHttpRefusal = "noOptIn" | "notLocal" | "secret" | "notAllowed";

/** A connection over plain http was refused before anything was sent; `reason` says why. .NET: `McpPlainHttpRefusedException`. */
export class McpPlainHttpRefusedError extends McpError {
  override readonly name = "McpPlainHttpRefusedError";
  readonly reason: McpPlainHttpRefusal;

  constructor(reason: McpPlainHttpRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The profile's feature that lets the SDK send `local_mcp.plain_http`. .NET: `LocalMcpModule.PlainHttpEventFeature`. */
export const PLAIN_HTTP_EVENT_FEATURE = "client_events.local_mcp_plain_http";

/** The version of the warning a person confirms before the switch turns on; the app shows that warning and passes this. */
export type PlainHttpWarningVersion = string;

/**
 * Plain http on the local network is allowed here: the agent's profile says `local_mcp.plain_http: allow` (absent or anything
 * else is deny; developer mode does not override it) and this computer's policy does not forbid plain http. The person's switch
 * per server is still needed. .NET: `LocalMcpModule.PlainHttpPermitted`.
 */
export function plainHttpPermitted(context: Pick<AgentContext, "profile" | "machinePolicy">): boolean {
  return context.profile.localMcp.plainHttp === "allow" && context.machinePolicy.plainHttp === PolicyAccess.Allowed;
}

/** The three spellings a browser never asks DNS about, where a header value may go over plain http (sdk/51 F03's rule for keys). */
function exactlyThisComputer(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Where an MCP server over plain http may be reached (sdk/51 F05; OWASP ASVS 5.0 V12), decided before anything is sent:
 * - https goes anywhere (returns false);
 * - plain http goes to this computer (`hostScope` loopback; with a header value, only `localhost`, `127.0.0.1` or `::1`), and
 *   returns false;
 * - plain http to the local network (a host whose spelling is private: an RFC 1918, link-local or fc00::/7 address, a single-label
 *   name, or `.local`, `.lan`, `.home.arpa`, `.internal`) needs the person's switch, where `permitted`, and never with a header
 *   value; returns true;
 * - anything else is refused (`McpPlainHttpRefusedError`).
 *
 * This differs from .NET, which resolves a name and holds the connection to the checked address: a browser cannot resolve, so a
 * name that merely looks local could point anywhere. That is why the switch is the person's, behind a warning, and https stays
 * the way for anything beyond this computer.
 */
export function checkMcpPlainHttp(url: URL, server: { headers?: Record<string, string> | undefined; plainHttpInLan?: boolean | undefined },
  permitted: boolean): boolean {
  if (url.protocol !== "http:") return false;
  const secrets = Object.keys(server.headers ?? {}).length > 0;
  const scope = hostScope(url.hostname);
  if (scope === "loopback") {
    if (secrets && !exactlyThisComputer(url)) {
      throw new McpPlainHttpRefusedError("secret", "A header value goes over plain http only to localhost, 127.0.0.1 or ::1: use https.");
    }
    return false;
  }
  if (secrets) {
    throw new McpPlainHttpRefusedError("secret", "A server with a header value is reached over plain http only on this computer: use https.");
  }
  if (server.plainHttpInLan !== true) {
    throw new McpPlainHttpRefusedError("noOptIn",
      "Plain http goes only to this computer unless \"Allow plain http on the local network\" is on for this server.");
  }
  if (!permitted) throw new McpPlainHttpRefusedError("notAllowed", "Plain http is not allowed here.");
  if (scope !== "private") {
    throw new McpPlainHttpRefusedError("notLocal", "Plain http goes only to the local network; this address is outside it.");
  }
  return true;
}

/** A server's origin, `http://host[:port]`, as core wants it in `local_mcp.plain_http` and the audit log keeps it. */
export function mcpOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}
