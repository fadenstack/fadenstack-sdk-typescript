// What a UI-automation tool (or a screen reader) finds in a view: every control, and every element that has a name, an id or a
// label. Shared by the React and the Vue snapshot tests. The styling pass must not change a line of it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONTROLS = "button, a, input, select, textarea, [role], [tabindex]";
const NAMED = "[id], [aria-label], [aria-labelledby], [aria-describedby], [name], [data-testid]";

/** The generated start of an id (React's useId, Vue's counters) depends on how many views were drawn before; it is numbered by first use instead. */
const GENERATED = /^(?:_r_\w+_|:r\w+:|v-\d+)/;

export function collectAutomation(root: Element): string[] {
  const ids = new Map<string, string>();
  const numbered = (id: string): string =>
    id.replace(GENERATED, (prefix) => {
      if (!ids.has(prefix)) ids.set(prefix, `#${ids.size}`);
      return ids.get(prefix)!;
    });
  const refs = (value: string | null): string => (value ?? "").split(/\s+/).filter(Boolean).map(numbered).join(" ");
  const lines: string[] = [];
  if (typeof root.querySelectorAll !== "function") return lines; // a view that draws nothing (the finished wizard)
  for (const el of root.querySelectorAll(`${CONTROLS}, ${NAMED}`)) {
    lines.push([
      el.tagName.toLowerCase(),
      el.getAttribute("role") ?? "",
      numbered(el.getAttribute("id") ?? ""),
      el.getAttribute("name") ?? "",
      el.getAttribute("aria-label") ?? "",
      refs(el.getAttribute("aria-labelledby")),
      refs(el.getAttribute("aria-describedby")),
      el.getAttribute("data-testid") ?? "",
      el.getAttribute("type") ?? "",
    ].join("|"));
  }
  return lines;
}

/** Records the lines (FADEN_AUTOMATION_WRITE=1) or compares them with the recorded file. */
export function finishSnapshot(file: string, recorded: Record<string, string[]>): { write: boolean; before?: Record<string, string[]> } {
  if (process.env.FADEN_AUTOMATION_WRITE === "1") {
    writeFileSync(file, JSON.stringify(recorded, null, 1) + "\n", "utf8");
    return { write: true };
  }
  if (!existsSync(file)) throw new Error(`no ${file}; record it with FADEN_AUTOMATION_WRITE=1`);
  return { write: false, before: JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]> };
}

/** The lost and the new lines of one view-state (empty when identical). */
export function diffLines(before: readonly string[], after: readonly string[]): string[] {
  const out: string[] = [];
  if (before.length === after.length && before.every((l, i) => l === after[i])) return out;
  const b = new Map<string, number>();
  for (const l of before) b.set(l, (b.get(l) ?? 0) + 1);
  for (const l of after) {
    const n = b.get(l) ?? 0;
    if (n > 0) b.set(l, n - 1);
    else out.push(`new:  ${l}`);
  }
  for (const [l, n] of b) for (let i = 0; i < n; i++) out.push(`lost: ${l}`);
  if (out.length === 0) out.push("same lines, different order");
  return out;
}
