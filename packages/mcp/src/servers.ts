import { hostScope } from "@fadenstack/client";

import { McpConfigError } from "./errors.js";

/** What the person may raise a tool to: never below what a destructive hint sets (`toolClassFor`). */
export type RaisedClass = "read" | "write";

/**
 * One of the person's HTTP MCP servers, as the module and the store hold it. The header values are secrets (a token): the store
 * seals them, the module sends them, and nothing logs or reports them. .NET: `LocalMcpServer.Http` plus the desktop's `McpServerEntry`.
 */
export interface McpServerRecord {
  /** What the person and the model see it as; unique in the list without regard to case. */
  label: string;
  /** The endpoint: https anywhere; plain http to this computer, or to the local network with `plainHttpInLan` (sdk/51 F05). */
  url: string;
  /** Sent with every request. */
  headers: Record<string, string>;
  /** Whether the server is attached. A server that was imported arrives off. */
  enabled: boolean;
  /**
   * The person's word that this server tells the truth about its tools: its `readOnlyHint` then counts (H4). It means nothing in
   * governed mode, where only the administrator's list counts.
   */
  trusted: boolean;
  /** The person's raise of single tools, by the name the server knows them by (H4); never below a destructive hint. */
  toolClasses: Record<string, RaisedClass>;
  /** How long one call may take, in seconds (default 120, at most 600). */
  callTimeoutS?: number;
  /** Where the record came from, when it was imported: `mcpServers` or `servers`. */
  importedFrom?: string;
  /** False for a server that was imported and that the person has not switched on yet ("not reviewed"). */
  reviewed: boolean;
  /**
   * The person's switch under Advanced, "Allow plain http on the local network" (sdk/51 F05): then plain http may go to a host on
   * the local network, never with a header value, and only where the agent and this computer's policy allow it (`checkMcpPlainHttp`).
   * Off by default; an import never sets it. Set through `McpModule.setPlainHttpInLan`, which asks for the warning's version.
   */
  plainHttpInLan?: boolean;
}

/** A server an app brings itself (a fixed entry of `McpOptions.servers`): always listed, never stored, on. */
export interface McpAppServer {
  label: string;
  url: string;
  headers?: Record<string, string>;
  /** The app's word that the server's hints are true (standalone only; in governed mode the administrator's list decides). */
  trusted?: boolean;
  callTimeoutS?: number;
}

export const LABEL_MAX = 40;
export const URL_MAX = 2048;
export const HEADERS_MAX = 20;
export const DEFAULT_CALL_TIMEOUT_S = 120;
export const MAX_CALL_TIMEOUT_S = 600;

/** Headers the transport owns: a server entry cannot override them. */
const TRANSPORT_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "origin", "cookie"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Whether `url` is on this computer: http or https to `localhost`, 127.0.0.0/8 or `::1`. .NET: `LocalMcpServer.IsLoopback`. */
export function isLoopbackUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1" || host === "::ffff:127.0.0.1";
}

/**
 * Checks a server's label, address and headers; throws `McpConfigError` for the first rule it breaks. The address is https
 * anywhere, or plain http: to this computer, or to a host on the local network that is kept and waits for the person's switch
 * (whether it may connect is decided when it does, `checkMcpPlainHttp`). Plain http beyond this computer never carries a header
 * value and never goes to a host outside the local network, which no switch could change. No user name or password in it, at
 * most 2,048 characters. .NET: `McpServerValidator`.
 */
export function checkServer(server: { label: string; url: string; headers?: Record<string, string> | undefined }): URL {
  const label = server.label;
  if (typeof label !== "string" || label.trim() === "") throw new McpConfigError("A server needs a label.");
  if (label !== label.trim() || [...label].length > LABEL_MAX || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(label)) {
    throw new McpConfigError(`A label is letters, digits, space, dot, dash and underscore, at most ${LABEL_MAX} characters: '${label.slice(0, 60)}'.`);
  }
  if (typeof server.url !== "string" || server.url.length > URL_MAX) throw new McpConfigError(`The address of '${label}' is missing or too long.`);
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new McpConfigError(`The address of '${label}' is not a web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpConfigError(`The address of '${label}' must be http or https.`);
  if (url.username !== "" || url.password !== "") throw new McpConfigError(`The address of '${label}' carries a user name or password: put it in a header.`);
  const headers = server.headers ?? {};
  if (url.protocol === "http:" && !isLoopbackUrl(url)) {
    if (Object.keys(headers).length > 0) {
      throw new McpConfigError(`'${label}' sends a header over plain http to another computer: use https.`, "plainHttpWithHeaders");
    }
    if (hostScope(url.hostname) !== "private") {
      throw new McpConfigError(`'${label}' uses plain http to an address outside the local network: use https.`, "plainHttpNotLocal");
    }
  }
  const names = Object.keys(headers);
  if (names.length > HEADERS_MAX) throw new McpConfigError(`'${label}' has more than ${HEADERS_MAX} headers.`);
  for (const name of names) {
    const value = headers[name];
    if (!TOKEN.test(name)) throw new McpConfigError(`A header name of '${label}' is not valid.`);
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) throw new McpConfigError(`The header '${name}' of '${label}' is set by the transport and cannot be given.`);
    // the value is never put in the message: it is a secret
    if (typeof value !== "string" || /[\r\n\u0000]/.test(value) || value.length > 4096) throw new McpConfigError(`The value of header '${name}' of '${label}' is not valid.`);
  }
  return url;
}

/** `callTimeoutS` as a number of milliseconds: the default for none, at most 10 minutes. */
export function callTimeoutMs(seconds: number | undefined, fallbackS: number = DEFAULT_CALL_TIMEOUT_S): number {
  const s = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackS;
  return Math.min(s, MAX_CALL_TIMEOUT_S) * 1000;
}

/** A record with every field present, from a partial one (what the store and the import hand over). */
export function recordOf(server: Partial<McpServerRecord> & { label: string; url: string }): McpServerRecord {
  return {
    label: server.label,
    url: server.url,
    headers: { ...(server.headers ?? {}) },
    enabled: server.enabled ?? false,
    trusted: server.trusted ?? false,
    toolClasses: { ...(server.toolClasses ?? {}) },
    ...(server.callTimeoutS !== undefined ? { callTimeoutS: server.callTimeoutS } : {}),
    ...(server.importedFrom !== undefined ? { importedFrom: server.importedFrom } : {}),
    reviewed: server.reviewed ?? true,
    ...(server.plainHttpInLan === true ? { plainHttpInLan: true } : {}),
  };
}
