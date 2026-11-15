import { McpConfigError, type McpConfigProblem } from "./errors.js";
import { LABEL_MAX, checkServer, isLoopbackUrl, recordOf, type McpServerRecord } from "./servers.js";

/** A server of a pasted configuration that did not come in, and why. */
export interface McpImportSkipped {
  label: string;
  reason: string;
  /**
   * `stdio` for a server that starts a program (not possible in a browser), `sse`, `plainHttp` for plain http beyond this computer
   * (the person adds it by hand and turns its switch on: an import never does, sdk/51 F05), or `invalid`.
   */
  kind: "stdio" | "sse" | "plainHttp" | "invalid";
  /** For `invalid`: which rule it breaks, or `noAddress` (no `url`), so a host can word it; undefined when it is none of these. */
  why?: McpConfigProblem | "noAddress";
}

/** What a pasted configuration holds. */
export interface McpImportResult {
  /** Which key it was found under: `mcpServers` (Claude Desktop, Cursor and others), `servers` (VS Code), or `mcp.servers` (VS Code's settings). */
  shape: "mcpServers" | "servers" | "mcp.servers";
  /** The HTTP servers, every one off and not reviewed. */
  servers: McpServerRecord[];
  /** The ones that are not HTTP, or not usable. */
  skipped: McpImportSkipped[];
  /** Things the person should know that are not errors (a header left out because its value is a placeholder). */
  notes: string[];
  /** The names of the headers left out of a server that came in, by its label (a host words this itself; the notes are English). */
  leftOut: Record<string, string[]>;
}

/** The longest configuration read, and the most servers taken from it. */
export const MAX_IMPORT_CHARS = 256 * 1024;
export const MAX_IMPORT_SERVERS = 100;

/** JSON with comments and trailing commas, as VS Code writes it, made plain JSON. Strings are left alone. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a pasted configuration: `{ "mcpServers": { "name": { "url": ..., "headers": {...} } } }` (Claude Desktop, Cursor and others),
 * VS Code's `{ "servers": { "name": { "type": "http", "url": ... } } }` (and `mcp.servers` of its settings). HTTP servers come in;
 * a server that starts a program (`command`, or `type: stdio`) is listed as not possible in a browser, one on the old SSE transport
 * as not supported. Every server that comes in is off and not reviewed: the person switches each on, and a server never starts
 * because it was pasted. Throws `McpConfigError` for text that is not a configuration. Nothing is sent anywhere and no header value
 * is put in a message. .NET: the desktop's `McpImport`, which also reads the other apps' files from disk (a browser has no disk to look in).
 */
export function parseMcpConfig(text: string): McpImportResult {
  if (typeof text !== "string" || text.trim() === "") throw new McpConfigError("There is nothing to import.", "importEmpty");
  if (text.length > MAX_IMPORT_CHARS) throw new McpConfigError("The configuration is too long to import.", "importTooLarge");
  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(text.replace(/^\uFEFF/, "")));
  } catch {
    throw new McpConfigError("The text is not JSON.", "importNotJson");
  }
  let shape: McpImportResult["shape"] = "mcpServers";
  let table: unknown;
  if (isObject(root) && isObject(root["mcpServers"])) table = root["mcpServers"];
  else if (isObject(root) && isObject(root["servers"])) { table = root["servers"]; shape = "servers"; }
  else if (isObject(root) && isObject(root["mcp"]) && isObject((root["mcp"] as Record<string, unknown>)["servers"])) {
    table = (root["mcp"] as Record<string, unknown>)["servers"];
    shape = "mcp.servers";
  }
  if (!isObject(table)) throw new McpConfigError("There is no 'mcpServers' or 'servers' entry in the text.", "importNoList");

  const servers: McpServerRecord[] = [];
  const skipped: McpImportSkipped[] = [];
  const notes: string[] = [];
  const leftOut: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const [name, definition] of Object.entries(table).slice(0, MAX_IMPORT_SERVERS)) {
    const label = name.trim().slice(0, 200);
    const skip = (kind: McpImportSkipped["kind"], reason: string, why?: McpImportSkipped["why"]) =>
      skipped.push({ label: label.slice(0, LABEL_MAX), reason, kind, ...(why !== undefined ? { why } : {}) });
    if (!isObject(definition)) { skip("invalid", "The entry is not an object."); continue; }
    const type = typeof definition["type"] === "string" ? definition["type"].toLowerCase() : undefined;
    if (type === "stdio" || (type === undefined && typeof definition["command"] === "string")) {
      skip("stdio", "It starts a program on this computer, which a browser cannot do.");
      continue;
    }
    if (type === "sse") { skip("sse", "It uses the old SSE transport, which this app does not support."); continue; }
    if (type !== undefined && type !== "http" && type !== "streamable-http" && type !== "streamablehttp") {
      skip("invalid", `The type '${type.slice(0, 30)}' is not one this app knows.`);
      continue;
    }
    const url = typeof definition["url"] === "string" ? definition["url"] : typeof definition["serverUrl"] === "string" ? definition["serverUrl"] : undefined;
    if (url === undefined) { skip("invalid", "It has no address ('url').", "noAddress"); continue; }
    const headers: Record<string, string> = {};
    const rawHeaders = definition["headers"];
    if (rawHeaders !== undefined && !isObject(rawHeaders)) { skip("invalid", "Its headers are not an object."); continue; }
    for (const [header, value] of Object.entries(rawHeaders ?? {})) {
      if (typeof value !== "string") {
        notes.push(`${label.slice(0, LABEL_MAX)}: the header '${header.slice(0, 40)}' was left out (its value is not text).`);
        (leftOut[label] ??= []).push(header.slice(0, 40));
        continue;
      }
      if (/\$\{[^}]*\}|\$\([^)]*\)/.test(value)) {
        notes.push(`${label.slice(0, LABEL_MAX)}: the header '${header.slice(0, 40)}' was left out (its value is a placeholder this app cannot fill; add it by hand).`);
        (leftOut[label] ??= []).push(header.slice(0, 40));
        continue;
      }
      headers[header] = value;
    }
    if (seen.has(label.toLowerCase())) { skip("invalid", "Another entry has the same label."); continue; }
    let address: URL;
    try {
      address = checkServer({ label, url, headers });
    } catch (error) {
      skip("invalid", error instanceof McpConfigError ? error.message : "It is not usable.", error instanceof McpConfigError ? error.problem : undefined);
      continue;
    }
    if (address.protocol === "http:" && !isLoopbackUrl(address)) {
      skip("plainHttp", "It uses plain http to another computer: add it by hand and turn on \"Allow plain http on the local network\".");
      continue;
    }
    seen.add(label.toLowerCase());
    servers.push(recordOf({ label, url, headers, enabled: false, trusted: false, reviewed: false, importedFrom: shape === "mcp.servers" ? "servers" : shape }));
  }
  if (Object.keys(table).length > MAX_IMPORT_SERVERS) notes.push(`Only the first ${MAX_IMPORT_SERVERS} servers were read.`);
  return { shape, servers, skipped, notes, leftOut };
}
