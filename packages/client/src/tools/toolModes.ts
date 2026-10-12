/**
 * Tool classes and tool modes: the same names and the same table as the gateway's,
 * so a session and the gateway decide alike.
 */

/** What a tool does. `unknown`: nobody vouched for it -- it always asks, and read-only hides it. */
export type ToolClass = "read" | "write" | "destructive" | "unknown";

/** What the user lets tools do in a session. Every session starts in `ask`. */
export type ToolMode = "off" | "read_only" | "ask" | "auto";

/** What a mode does with a tool: runs it, asks first, or hides it (not offered; refused if called anyway). */
export type ToolModeDecision = "run" | "ask" | "hidden";

/** The modes from narrowest to widest. */
export const TOOL_MODES: readonly ToolMode[] = ["off", "read_only", "ask", "auto"];

/** The header a request carries its session's mode in. */
export const TOOL_MODE_HEADER = "X-Faden-Tool-Mode";

/**
 * `open_world` (reaches outside the organisation) is carried and shown, and no mode acts on it yet -- like the
 * gateway's `OPEN_WORLD_ENFORCED`.
 */
export const OPEN_WORLD_ENFORCED = false;

/**
 *     mode        read  write   destructive  unknown
 *     off         -     -       -            -
 *     read_only   run   -       -            -
 *     ask         run   ask     ask          ask
 *     auto        run   run     ask          ask
 */
export function decideTool(mode: ToolMode, toolClass: ToolClass): ToolModeDecision {
  switch (mode) {
    case "off":
      return "hidden";
    case "read_only":
      return toolClass === "read" ? "run" : "hidden";
    case "ask":
      return toolClass === "read" ? "run" : "ask";
    case "auto":
      return toolClass === "read" || toolClass === "write" ? "run" : "ask";
    default:
      return "hidden";
  }
}

/** The narrower of a mode and a ceiling (a ceiling never widens). */
export function narrowestMode(mode: ToolMode, ceiling: ToolMode | null | undefined): ToolMode {
  if (!ceiling) return mode;
  return TOOL_MODES.indexOf(ceiling) < TOOL_MODES.indexOf(mode) ? ceiling : mode;
}

export function parseToolMode(value: string | null | undefined): ToolMode | undefined {
  const v = value?.trim().toLowerCase();
  return (TOOL_MODES as readonly string[]).includes(v ?? "") ? (v as ToolMode) : undefined;
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
