/**
 * Tool classes and tool modes: the same names and the same table as the gateway's,
 * so a session and the gateway decide alike.
 */

/** What a tool does. `unknown`: nobody vouched for it -- it always asks, and read-only hides it. */
export type ToolClass = "read" | "write" | "destructive" | "unknown";

/**
 * What the user lets tools do in a session. Every session starts in `ask`. `bypass` is the server's Bypass: `auto`, plus
 * what the conversation's Bypass grant covers (destructive and unclassified calls). It holds only while the server
 * holds that grant; nobody picks it from a menu (`TOOL_MODES` does not list it).
 */
export type ToolMode = "off" | "read_only" | "ask" | "auto" | "bypass";

/** What a mode does with a tool: runs it, asks first, or hides it (not offered; refused if called anyway). */
export type ToolModeDecision = "run" | "ask" | "hidden";

/** The modes a person picks from a menu, from narrowest to widest. Bypass is switched on with its own confirmation. */
export const TOOL_MODES: readonly Exclude<ToolMode, "bypass">[] = ["off", "read_only", "ask", "auto"];

/** All modes from narrowest to widest. */
const MODE_ORDER: readonly ToolMode[] = [...TOOL_MODES, "bypass"];

/** The header a request carries its session's mode in. */
export const TOOL_MODE_HEADER = "X-Faden-Tool-Mode";

/**
 * `open_world` (reaches outside the organisation) is acted on: below `auto` a call to an open-world tool asks
 * (`decideTool`), like the gateway's `OPEN_WORLD_ENFORCED` from 0.7.1.
 */
export const OPEN_WORLD_ENFORCED = true;

/**
 *     mode        read  write   destructive  unknown
 *     off         -     -       -            -
 *     read_only   run   -       -            -
 *     ask         run   ask     ask          ask
 *     auto        run   run     ask          ask
 *     bypass      run   run     ask*         ask*      * run under the conversation's Bypass grant (the caller checks it)
 *
 * An open-world tool (`openWorld`: the stricter of the tool's own mark and the gateway's) asks below `auto` where the
 * table says run: what it is given leaves the organisation, and injected text can put private data into it (sdk/51 F08
 * §4; OWASP Top 10 for LLM Applications 2025, LLM02, LLM06). `auto` and `bypass` run it. The contract's `approval`
 * goes on top, as before: `never` still runs a read or write tool.
 */
export function decideTool(mode: ToolMode, toolClass: ToolClass, approval?: string, openWorld?: boolean): ToolModeDecision {
  // Contract hints never unhide a tool or relax a destructive/unknown class.
  if (mode !== "off" && (mode !== "read_only" || toolClass === "read")) {
    if (approval === "always" || approval === "ask") return "ask";
    if (approval === "never" && (toolClass === "read" || toolClass === "write")) return "run";
  }
  const decision = byTable(mode, toolClass);
  return decision === "run" && conversationOnly(mode, openWorld) ? "ask" : decision;
}

/**
 * Whether an approval of an open-world call may stand only for the conversation: below `auto` it asks because what it is
 * given leaves the organisation, so neither "always" nor a time grant answers it (sdk/51 F08 §4).
 */
export function conversationOnly(mode: ToolMode, openWorld: boolean | undefined): boolean {
  return openWorld === true && MODE_ORDER.indexOf(mode) < MODE_ORDER.indexOf("auto");
}

function byTable(mode: ToolMode, toolClass: ToolClass): ToolModeDecision {
  switch (mode) {
    case "off":
      return "hidden";
    case "read_only":
      return toolClass === "read" ? "run" : "hidden";
    case "ask":
      return toolClass === "read" ? "run" : "ask";
    case "auto":
    case "bypass":
      return toolClass === "read" || toolClass === "write" ? "run" : "ask";
    default:
      return "hidden";
  }
}

/** The narrower of a mode and a ceiling (a ceiling never widens). */
export function narrowestMode(mode: ToolMode, ceiling: ToolMode | null | undefined): ToolMode {
  if (!ceiling) return mode;
  return MODE_ORDER.indexOf(ceiling) < MODE_ORDER.indexOf(mode) ? ceiling : mode;
}

export function parseToolMode(value: string | null | undefined): ToolMode | undefined {
  const v = value?.trim().toLowerCase();
  return (MODE_ORDER as readonly string[]).includes(v ?? "") ? (v as ToolMode) : undefined;
}

/** A contract's `risk`, or a class name; anything else is `unknown`. */
export function parseToolClass(value: string | null | undefined): ToolClass {
  const v = value?.trim().toLowerCase();
  return v === "read" || v === "write" || v === "destructive" ? v : "unknown";
}

const RANK: Record<ToolClass, number> = { read: 0, write: 1, destructive: 2, unknown: 2 };

/**
 * The class a tool runs under: the stricter of the integrator's and the agent contract's `risk`. The client may
 * be stricter than the server, never looser.
 */
export function effectiveToolClass(declared: ToolClass, contract: ToolClass | undefined): ToolClass {
  if (!contract || contract === "unknown") return declared;
  if (declared === "unknown") return contract;
  return RANK[declared] >= RANK[contract] ? declared : contract;
}
