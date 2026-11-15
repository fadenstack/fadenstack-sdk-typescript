import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss, { type Declaration, type Rule } from "postcss";

// The radius system of the connection wizard and the skill views: 12 px for a container, 6 px for a control, 8 px for a chip, so
// nothing else creeps back in. The chat panel is out of this rule and keeps its own shapes.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui-web", "styles.css"), "utf8");
const root = postcss.parse(css);

const WIZARD_FROM = css.indexOf("/* -- the connection wizard");
const radii: { selector: string; value: string; inWizard: boolean }[] = [];
root.walkRules((rule: Rule) => {
  rule.walkDecls("border-radius", (d: Declaration) => {
    radii.push({ selector: rule.selector, value: d.value.trim(), inWizard: (d.source?.start?.offset ?? 0) >= WIZARD_FROM });
  });
});

describe("the radius system of the wizard and skill views", () => {
  it("has the three radii as tokens next to --fdn-radius", () => {
    expect(WIZARD_FROM).toBeGreaterThan(0);
    const tokens = root.nodes.flatMap((n) => (n.type === "rule" && n.selector === ".fdn-chat" ? n.nodes : [])).filter((d): d is Declaration => d.type === "decl");
    const value = (name: string) => tokens.find((d) => d.prop === name)?.value;
    expect(value("--fdn-radius")).toBe("12px");
    expect(value("--fdn-radius-control")).toBe("6px");
    expect(value("--fdn-radius-chip")).toBe("8px");
  });

  it("uses only a token, 0, a circle or the switch's pill after the wizard section starts", () => {
    const allowed = new Set(["var(--fdn-radius)", "var(--fdn-radius-control)", "var(--fdn-radius-chip)", "0", "50%", "999px"]);
    const inside = radii.filter((r) => r.inWizard);
    expect(inside.length).toBeGreaterThan(8);
    for (const r of inside) expect(allowed.has(r.value), `${r.selector}: ${r.value}`).toBe(true);
  });

  it("applies the control and chip radii only inside the wizard and skill scopes (the chat panel keeps its own)", () => {
    for (const r of radii) {
      if (!/--fdn-radius-(control|chip)/.test(r.value)) continue;
      expect(r.inWizard, `${r.selector} is before the wizard section`).toBe(true);
      expect(/\.fdn-(wizard|skills)/.test(r.selector), `${r.selector} is outside the wizard and skill scopes`).toBe(true);
    }
  });

  it("allows the pill only on the switch", () => {
    for (const r of radii.filter((x) => x.inWizard && x.value === "999px")) expect(r.selector).toContain('[role="switch"]');
  });
});
