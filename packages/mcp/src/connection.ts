import { Client, SdkErrorCode, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";

import { McpConnectError, type McpConnectFailure } from "./errors.js";
import type { McpToolHints } from "./hints.js";
import { cleanResult, cleanSchema, fence, firstLine, oneLine } from "./text.js";

/** The name this client gives the server (`clientInfo`). */
const CLIENT_NAME = "fadenstack-agent";

/** The most a server's instructions put in an index line. */
export const MAX_INDEX_CHARS = 80;

/** A tool a server brought, as the module keeps it. */
export interface ListedTool {
  /** The name the server knows it by. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hints: McpToolHints;
}

export interface ConnectOptions {
  label: string;
  url: URL;
  headers: Record<string, string>;
  fetch?: typeof fetch | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  version: string;
}

/**
 * One live client of one server over Streamable HTTP, the only transport a browser has (.NET also starts programs). It speaks
 * 2026-07-28 (no `initialize`, no session) and falls back to 2025-11-25: `versionNegotiation: { mode: 'auto' }`, because the
 * client's own default is the old revision only. Only the package's main entry is imported, never `/stdio`: it needs Node.
 * Capabilities are none: the server is never asked for the model (no sampling), no folders (no roots), and cannot ask the person
 * a question (no elicitation).
 */
export class McpConnection {
  readonly label: string;
  /** The revision the connection runs on: `2026-07-28`, or `2025-11-25` and older. */
  readonly protocolVersion: string | undefined;
  /** The first line of the server's instructions (cleaned, at most 80 characters), or undefined. */
  readonly instructions: string | undefined;
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  #closed = false;

  private constructor(label: string, client: Client, transport: StreamableHTTPClientTransport) {
    this.label = label;
    this.#client = client;
    this.#transport = transport;
    this.protocolVersion = client.getNegotiatedProtocolVersion();
    this.instructions = firstLine(client.getInstructions(), MAX_INDEX_CHARS);
  }

  /** Connects and negotiates. Throws `McpConnectError`; its message and fields carry neither the address nor a header. */
  static async open(options: ConnectOptions): Promise<McpConnection> {
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: { headers: options.headers },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const client = new Client({ name: CLIENT_NAME, version: options.version }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(transport, { timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new McpConnectError(options.label, failureOf(error, options.signal), { cause: error });
    }
    return new McpConnection(options.label, client, transport);
  }

  /** All the server's tools (every page). Throws `McpConnectError` when the server stopped answering. */
  async listTools(signal?: AbortSignal): Promise<ListedTool[]> {
    try {
      const result = await this.#client.listTools(undefined, signal ? { signal } : undefined);
      return result.tools.map(toListed);
    } catch (error) {
      throw new McpConnectError(this.label, failureOf(error, signal), { cause: error });
    }
  }

  /** Calls a tool; the result as text for the model, fenced as untrusted data. A server's error is text too ("Error: ..."). */
  async call(tool: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }): Promise<string> {
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args }, { signal: options.signal, timeout: options.timeoutMs });
      return fence(this.label, tool, describe(result));
    } catch (error) {
      if (options.signal.aborted) throw error; // the person stopped it: the client has sent the cancel notice
      if (code(error) === SdkErrorCode.RequestTimeout) {
        return `Error: the MCP server ${oneLine(this.label, 40)} did not answer within ${Math.ceil(options.timeoutMs / 1000)} seconds; the call was cancelled.`;
      }
      if (isProtocolError(error)) return fence(this.label, tool, `Error: ${oneLine(messageOf(error), 300)}`); // the server's own answer
      return `Error: the MCP server ${oneLine(this.label, 40)} stopped answering.`;
    }
  }

  /** Ends the session (an HTTP DELETE where the server keeps one) and releases the client. Never throws. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // a server that keeps a session (2025-11-25) is told it ends; a 2026-07-28 connection has none
    if (this.#transport.sessionId !== undefined) await this.#transport.terminateSession().catch(() => undefined);
    await this.#client.close().catch(() => undefined);
  }
}

function toListed(tool: Tool): ListedTool {
  const a = (tool.annotations ?? {}) as Record<string, unknown>;
  const flag = (key: string): boolean | undefined => (typeof a[key] === "boolean" ? (a[key] as boolean) : undefined);
  const hints: McpToolHints = {};
  const title = typeof a["title"] === "string" ? a["title"] : typeof tool.title === "string" ? tool.title : undefined;
  if (title !== undefined) hints.title = oneLine(title, 120);
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    const value = flag(key);
    if (value !== undefined) hints[key] = value;
  }
  const description = cleanResult(tool.description ?? "").trim();
  return {
    name: tool.name,
    description: description.length > 1024 ? `${description.slice(0, 1023)}\u2026` : description,
    // The parameters' words too, not only the tool's (release plan S2).
    inputSchema: cleanSchema((tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>),
    hints,
  };
}

/** A result's text for the model: text parts, an embedded text resource, a note for what is left out, the structured content when that is all there is. */
function describe(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): string {
  const parts: string[] = [];
  for (const block of Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : []) {
    switch (block["type"]) {
      case "text":
        parts.push(String(block["text"] ?? ""));
        break;
      case "image":
        parts.push("[A picture from the server was left out.]");
        break;
      case "audio":
        parts.push("[Audio from the server was left out.]");
        break;
      case "resource": {
        const resource = block["resource"] as Record<string, unknown> | undefined;
        parts.push(typeof resource?.["text"] === "string" ? resource["text"] : "[A file from the server was left out.]");
        break;
      }
      case "resource_link":
        parts.push(`[A link from the server: ${oneLine(String(block["name"] ?? block["uri"] ?? ""), 200)}]`);
        break;
      default:
        parts.push("[Content of a kind this app does not read was left out.]");
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n");
  return result.isError === true ? `Error: ${text}` : text;
}

function code(error: unknown): string | number | undefined {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: string | number }).code : undefined;
}

function isProtocolError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "ProtocolError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the call failed";
}

/** What kind of failure an error of the client is, without passing on its text (it can carry an address). */
function failureOf(error: unknown, signal: AbortSignal | undefined): McpConnectFailure {
  if (signal?.aborted) return "stopped";
  const c = code(error);
  const status = (error as { data?: { status?: number } } | undefined)?.data?.status;
  if (status === 401 || status === 403 || (error as { name?: string } | undefined)?.name === "UnauthorizedError") return "unauthorized";
  if (c === SdkErrorCode.RequestTimeout) return "timeout";
  if (typeof c === "number" || c === SdkErrorCode.InvalidResult || c === SdkErrorCode.UnsupportedResultType) return "protocol";
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return "protocol";
  return "unreachable";
}
