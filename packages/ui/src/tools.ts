import type { AgentToolInfo, ToolClass } from "@fadenstack/client";

import { Observable } from "./observable.js";
import type { UiStrings } from "./strings.js";

let counter = 0;

/** The longest description shown, in characters: server-written text can be any length. */
const MAX_DESCRIPTION = 300;

/**
 * What the agent knows of a tool the app itself provides: only these three fields are read, so the view never holds the
 * tool's schema or its code.
 */
export interface HostToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly toolClass: ToolClass;
  /** `host` (the app) or `mcp` (an MCP server on this computer); a `gateway` tool is the server's and not listed here. */
  readonly source: string;
}

/** A tool of this app, with what it does to things drawn in the panel's language. */
export interface HostToolRow {
  name: string;
  /** Plain text, never HTML; cut to a few hundred characters. */
  description: string;
  toolClass: ToolClass;
  /** "Read", "Changes data", "Cannot be undone". */
  classLabel: string;
}

/** Whether a tool of the organisation's server can be used by this agent now. */
export type ServerToolStatus = "available" | "disabled" | "not_allowed";

export interface ServerToolRow {
  name: string;
  /** Written by the server: plain text, never HTML; cut to a few hundred characters. */
  description: string;
  status: ServerToolStatus;
  /** "Available to this agent", "Switched off by your administrator", "Not allowed for this agent". */
  statusLabel: string;
}

/** The tools of one MCP server of the organisation. */
export interface ServerToolGroup {
  server: string;
  tools: readonly ServerToolRow[];
}

/** `idle` before it was opened, then `loading`, and `ready` or `failed`. */
export type ToolsState = "idle" | "loading" | "ready" | "failed";

/** The status of a tool the server lists: switched off by the administrator first, then not allowed for this agent. */
export function serverToolStatus(tool: Pick<AgentToolInfo, "allowed" | "enabled">): ServerToolStatus {
  return !tool.enabled ? "disabled" : !tool.allowed ? "not_allowed" : "available";
}

function plain(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= MAX_DESCRIPTION ? flat : `${characters.slice(0, MAX_DESCRIPTION - 1).join("").trimEnd()}…`;
}

/**
 * What the agent can use, read only: the tools of this app (with what each does to things), and the tools of the
 * organisation's server for this agent, grouped by MCP server, each with whether it is available, switched off or not
 * allowed. The chat owns it (`chat.tools`) and loads the server's list when the view opens.
 *
 * There are no switches here. An agent chat keeps no session on the server, so a per-chat switch would need a change on
 * the server first; until then the administrator decides what is on, and this view only shows it.
 */
export class ToolsViewModel extends Observable {
  /** For the ids skins give the view's headings, unique on the page. */
  readonly key = `fdn-tools-${++counter}`;
  readonly #hostTools: () => readonly HostToolInfo[];
  readonly #load: (signal: AbortSignal) => Promise<AgentToolInfo[] | null>;
  readonly #strings: () => UiStrings;
  #state: ToolsState = "idle";
  #server: readonly AgentToolInfo[] = [];
  #abort: AbortController | undefined;

  constructor(options: {
    hostTools: () => readonly HostToolInfo[];
    /** The server's list; null when it has none (an older server), which reads as an empty list, not an error. */
    load: (signal: AbortSignal) => Promise<AgentToolInfo[] | null>;
    strings: () => UiStrings;
  }) {
    super();
    this.#hostTools = options.hostTools;
    this.#load = options.load;
    this.#strings = options.strings;
  }

  get state(): ToolsState {
    return this.#state;
  }

  get isLoading(): boolean {
    return this.#state === "loading";
  }

  /** The server's list could not be read just now. */
  get failed(): boolean {
    return this.#state === "failed";
  }

  /** The tools of this app, as the agent runs them. */
  get hostTools(): readonly HostToolRow[] {
    const s = this.#strings();
    return this.#hostTools()
      .filter((t) => t.source !== "gateway")
      .map((t) => ({ name: t.name, description: plain(t.description), toolClass: t.toolClass, classLabel: s.approvalClass[t.toolClass] }));
  }

  /** The server's tools by MCP server, in the order the server named them. */
  get serverGroups(): readonly ServerToolGroup[] {
    const s = this.#strings();
    const label: Record<ServerToolStatus, string> = { available: s.toolStatusAvailable, disabled: s.toolStatusDisabled, not_allowed: s.toolStatusNotAllowed };
    const groups = new Map<string, ServerToolRow[]>();
    for (const tool of this.#server) {
      const status = serverToolStatus(tool);
      const rows = groups.get(tool.server) ?? [];
      rows.push({ name: tool.name, description: plain(tool.description), status, statusLabel: label[status] });
      groups.set(tool.server, rows);
    }
    return [...groups].map(([server, tools]) => ({ server: server || s.serverTool, tools }));
  }

  /** The server lists no tools for this agent (or has no such list): "No tools from your server". */
  get isServerEmpty(): boolean {
    return this.#state === "ready" && this.#server.length === 0;
  }

  /** Reads the server's list (again). A newer call replaces one still running. */
  async load(): Promise<void> {
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#state = "loading";
    this.notify();
    try {
      const list = await this.#load(abort.signal);
      if (abort.signal.aborted) return;
      this.#server = list ?? [];
      this.#state = "ready";
    } catch {
      if (abort.signal.aborted) return;
      this.#state = "failed";
    }
    this.notify();
  }

  /** Stops a read that is still running (the view closed). */
  cancel(): void {
    this.#abort?.abort();
    if (this.#state === "loading") {
      this.#state = this.#server.length > 0 ? "ready" : "idle";
      this.notify();
    }
  }
}
