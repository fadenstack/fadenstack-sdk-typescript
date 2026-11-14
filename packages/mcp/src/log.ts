import { defineLog } from "@fadenstack/client";

/** The category of everything the MCP module logs. */
export const MCP_LOG_CATEGORY = "Fadenstack.Mcp";

/**
 * What the MCP module logs: server labels, transport kinds and tool counts -- never a URL, a header, tool names, arguments or results.
 * Event ids 3000-3099, the .NET SDK's (`Fadenstack.Mcp.Log`); the ones about processes and questions have no use here.
 */
export const McpLog = Object.freeze({
  attached: defineLog(MCP_LOG_CATEGORY, 3000, "Attached", "information", "MCP server {Label} ({Transport}) attached with {ToolCount} tools on {Protocol}"),
  refused: defineLog(MCP_LOG_CATEGORY, 3001, "Refused", "information", "MCP server {Label} ({Transport}) was refused by the agent's policy: {Reason}"),
  attachFailed: defineLog(MCP_LOG_CATEGORY, 3002, "AttachFailed", "warning", "MCP server {Label} ({Transport}) could not be attached ({ErrorType})"),
  callTimedOut: defineLog(MCP_LOG_CATEGORY, 3005, "CallTimedOut", "warning", "A call to MCP server {Label} did not finish within {Seconds} s and was cancelled"),
  toolNameReserved: defineLog(MCP_LOG_CATEGORY, 3007, "ToolNameReserved", "warning",
    "MCP server {Label} brought a tool under a name the SDK keeps for its own tools; it was left out"),
  toolNameTaken: defineLog(MCP_LOG_CATEGORY, 3008, "ToolNameTaken", "warning",
    "MCP server {Label} brought a tool whose name MCP server {Winner} already brings; the first server's is kept"),
  toolNameInvalid: defineLog(MCP_LOG_CATEGORY, 3010, "ToolNameInvalid", "warning",
    "MCP server {Label} brought a tool whose name cannot be used as it is; it was renamed"),
  storeUnreadable: defineLog(MCP_LOG_CATEGORY, 3011, "StoreUnreadable", "warning", "The person's own MCP servers could not be read ({ErrorType})"),
  headersUnreadable: defineLog(MCP_LOG_CATEGORY, 3012, "HeadersUnreadable", "warning",
    "The headers of MCP server {Label} could not be decrypted; the server was left off"),
});
