import { FadenstackError } from "@fadenstack/client";

/** Everything the MCP module throws is one of these, so a host can catch the family. .NET: the module's `ArgumentException`s and `McpException`. */
export class McpError extends FadenstackError {}

/** Why a server could not be attached. The message and the fields never carry the URL or a header. */
export type McpConnectFailure = "unreachable" | "timeout" | "unauthorized" | "protocol" | "stopped";

/** A server could not be attached (or lost): `reason` says which kind of failure it was. */
export class McpConnectError extends McpError {
  readonly label: string;
  readonly reason: McpConnectFailure;

  constructor(label: string, reason: McpConnectFailure, options?: { cause?: unknown }) {
    super(`The MCP server '${label}' could not be attached: ${REASONS[reason]}.`, options);
    this.label = label;
    this.reason = reason;
  }
}

const REASONS: Record<McpConnectFailure, string> = {
  unreachable: "it did not answer (the address is wrong, the server is down, or it does not allow this app's origin)",
  timeout: "it did not answer in time",
  unauthorized: "it refused the sign-in (check the headers)",
  protocol: "it does not speak a version of MCP this app supports over HTTP",
  stopped: "the attach was stopped",
};

/** A server's address, label or headers break a rule (`checkServer`), or a pasted configuration is not usable. */
export class McpConfigError extends McpError {}

/** The agent's policy or the machine policy does not allow a server. `reason` is the policy's own words. */
export class McpPolicyError extends McpError {
  readonly label: string;

  constructor(label: string, reason: string) {
    super(`The MCP server '${label}' is not allowed: ${reason}`);
    this.label = label;
  }
}

/** The person's servers could not be kept or read (no key to seal the headers, no store, a name that is taken). */
export class McpStoreError extends McpError {}
