import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type AtRule, type Rule } from "postcss";

// Shared by the React and Vue layout tests. jsdom has no layout engine, so the panel's layout rules are read from styles.css itself
// (postcss) and cascaded by specificity and order onto the really rendered elements (`computedRules`), and the few measurements a
// view takes (`getBoundingClientRect`) come from a small model of a panel with the menus' buttons at known places (`fakeLayout`).

const css = readFileSync(join(process.cwd(), "packages", "ui-web", "styles.css"), "utf8");

interface Flat { selector: string; decls: [string, string][]; order: number }
const flat: Flat[] = [];
let order = 0;
postcss.parse(css).walkRules((rule: Rule) => {
  const parent = rule.parent;
  if (parent && parent.type === "atrule" && (parent as AtRule).name === "media") return; // themes and forced colours only change tokens
  const decls: [string, string][] = [];
  rule.each((n) => { if (n.type === "decl") decls.push([n.prop, n.value]); });
  for (const selector of rule.selectors) flat.push({ selector: selector.trim(), decls, order: order++ });
});

function specificity(selector: string): number {
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const types = (selector.replace(/\[[^\]]*\]/g, "").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return classes * 100 + types;
}

/** The declarations of styles.css that reach `el`, the winner of each property (specificity, then source order); inline styles on top. */
export function computedRules(el: HTMLElement): Map<string, string> {
  const hits = flat.filter((f) => {
    try {
      return el.matches(f.selector);
    } catch {
      return false;
    }
  });
  hits.sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order);
  const out = new Map<string, string>();
  for (const f of hits) for (const [prop, value] of f.decls) out.set(prop, value);
  for (let i = 0; i < el.style.length; i++) out.set(el.style[i]!, el.style.getPropertyValue(el.style[i]!));
  return out;
}

interface Rect { left: number; right: number; width: number; top: number; bottom: number; height: number }
const rect = (left: number, right: number): Rect => ({ left, right, width: right - left, top: 0, bottom: 20, height: 20 });

/**
 * A panel `panelWidth` px wide at x 0 with each menu's anchor at `anchors(anchorElement)` (left, right), and a menu 300 px wide (or its
 * inline max-width): opened from the anchor's end edge unless `inset-inline-start` is set inline, then shifted by an inline translateX.
 * Returns the undo.
 */
export function fakeLayout(panelWidth: number, anchors: (anchor: HTMLElement) => [number, number]): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this.classList.contains("fdn-chat")) return rect(0, panelWidth) as DOMRect;
    if (this.classList.contains("fdn-menu") && this.closest(".fdn-menu-anchor")) {
      const [left, right] = anchors(this.closest<HTMLElement>(".fdn-menu-anchor")!);
      const width = Math.max(parseFloat(this.style.minWidth) || 0, Math.min(parseFloat(this.style.maxWidth) || 340, 300));
      const shift = /translateX\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1];
      const dx = shift ? parseFloat(shift) : 0;
      const fromStart = this.style.insetInlineStart === "0px" || this.style.insetInlineStart === "0";
      return (fromStart ? rect(left + dx, left + width + dx) : rect(right - width + dx, right + dx)) as DOMRect;
    }
    return original.call(this);
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

/** The menu's box in the fake layout, for the assertion that it lies inside the panel. */
export function menuBox(menu: HTMLElement): { left: number; right: number } {
  const r = menu.getBoundingClientRect();
  return { left: r.left, right: r.right };
}
