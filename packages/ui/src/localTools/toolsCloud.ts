import type { CloudToolInfo } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import type { UiStrings } from "../strings.js";
import { containsText } from "./contracts.js";

/** A cloud tool: its name, its description and what this assistant may do with it. */
export interface CloudToolViewModel {
  readonly name: string;
  readonly description: string;
  readonly hasDescription: boolean;
  readonly stateText: string;
  /** For this assistant (a success chip). */
  readonly isForThis: boolean;
  /** Not for this assistant (an outlined chip, the name muted). */
  readonly isNotFor: boolean;
  /** Switched off by an administrator (a muted chip, the name struck through). */
  readonly isOff: boolean;
  readonly isMuted: boolean;
}

function cloudTool(s: UiStrings, tool: CloudToolInfo): CloudToolViewModel {
  const isOff = !tool.enabled;
  const isForThis = tool.enabled && tool.allowed;
  return {
    name: tool.name,
    description: tool.description,
    hasDescription: tool.description !== "",
    stateText: isOff ? s.toolsCloudOffByAdmin : isForThis ? s.toolsCloudForThis : s.toolsCloudNotFor,
    isForThis,
    isNotFor: tool.enabled && !tool.allowed,
    isOff,
    isMuted: !isForThis,
  };
}

/** The cloud tools of one MCP server of the organisation, as a card with a collapsible list. */
export class CloudGroupViewModel extends Observable {
  readonly server: string;
  /** "6 tools · 4 for this assistant · 1 switched off". */
  readonly summary: string;
  readonly tools: readonly CloudToolViewModel[];
  readonly collapseName: string;
  readonly expandName: string;
  #expanded = true;

  constructor(s: UiStrings, server: string, tools: readonly CloudToolInfo[], filter = "") {
    super();
    this.server = server;
    const serverMatches = containsText(server, filter);
    this.tools = tools.filter((t) => serverMatches || containsText(t.name, filter)).map((t) => cloudTool(s, t));
    const parts = [tools.length === 1 ? s.toolsCountOne : s.toolsCountMany(tools.length), s.toolsForThisAssistant(tools.filter((t) => t.enabled && t.allowed).length)];
    const off = tools.filter((t) => !t.enabled).length;
    if (off > 0) parts.push(s.toolsSwitchedOffCount(off));
    this.summary = parts.join(" · ");
    this.collapseName = s.toolsCollapse(server);
    this.expandName = s.toolsExpand(server);
  }

  get isExpanded(): boolean {
    return this.#expanded;
  }

  get isCollapsed(): boolean {
    return !this.#expanded;
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
    this.notify();
  }
}
