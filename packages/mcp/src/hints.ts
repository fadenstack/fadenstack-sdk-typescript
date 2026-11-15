import type { ToolClass } from "@fadenstack/client";

import type { RaisedClass } from "./servers.js";

/**
 * What a server says about one of its tools (annotations). A server's word about itself: shown to the person, and used for the
 * tool's class only as the hint rule allows (`toolClassFor`). .NET: `McpToolHints`.
 */
export interface McpToolHints {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * The hint rule (sdk/51 F05, H4; the MCP spec says a client must treat annotations as untrusted unless the server is trusted):
 * - a tool arrives unclassified (`unknown`), so it asks;
 * - `destructiveHint: true` from any server makes it `destructive`, which always asks: a hint may only make a tool stricter, and
 *   destructive stays a floor that nothing below it (a raise, a trusted read hint) can lower;
 * - a `readOnlyHint` counts only from a server `trusted` by the person (standalone) or the administrator (governed): it makes the
 *   tool `read`; from another server it is ignored;
 * - only the person or the administrator raises a tool to `read` or `write` (`raised`).
 */
export function toolClassFor(hints: McpToolHints | undefined, options: { trusted: boolean; raised?: RaisedClass | undefined }): ToolClass {
  if (hints?.destructiveHint === true) return "destructive";
  if (options.raised === "read" || options.raised === "write") return options.raised;
  if (options.trusted && hints?.readOnlyHint === true) return "read";
  return "unknown";
}
