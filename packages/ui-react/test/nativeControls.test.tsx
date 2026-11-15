// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";

import { englishStrings } from "@fadenstack/ui";
import { ConnectionWizard, SkillDraft, SkillEditor, SkillLibrary } from "@fadenstack/ui-react";

import { ALL_STEPS, reach } from "./wizardHarness.js";
import {
  DRAFT_STATES,
  EDITOR_STATES,
  LIBRARY_STATES,
  reachDraft,
  reachEditor,
  reachLibrary,
} from "./skillHarness.js";

// No native control may keep a browser default that can be dark on dark or light on light. jsdom does not cascade the
// stylesheet, so the rules are read from styles.css itself (postcss) and matched against the real rendered elements
// (`matches`); the tokens of each theme are read from the same file and the WCAG 2.2 contrast of each pair is computed:
// 4.5:1 for text (1.4.3), 3:1 for a control's boundary, its ticked state and the focus ring (1.4.11).

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const css = readFileSync(here("../../ui-web/styles.css"), "utf8");
const root = postcss.parse(css);

// ---- The stylesheet: rules, tokens per theme ----

interface Decl { readonly prop: string; readonly value: string }
interface Flat { readonly selector: string; readonly decls: readonly Decl[]; readonly order: number; readonly media: string }

const flat: Flat[] = [];
let order = 0;
root.walkRules((rule: Rule) => {
  const parent = rule.parent;
  const media = parent && parent.type === "atrule" ? `${(parent as AtRule).name} ${(parent as AtRule).params}` : "";
  const decls: Decl[] = [];
  rule.walkDecls((d: Declaration) => {
    decls.push({ prop: d.prop, value: d.value });
  });
  for (const selector of rule.selectors) flat.push({ selector: selector.trim(), decls, order: order++, media });
});

type Theme = "light" | "dark" | "system-dark";
const THEMES: readonly Theme[] = ["light", "dark", "system-dark"];

function tokensOf(theme: Theme): Map<string, string> {
  const wanted: Record<Theme, (f: Flat) => boolean> = {
    light: (f) => f.media === "" && f.selector === ".fdn-chat",
    dark: (f) => f.media === "" && f.selector === '.fdn-chat[data-theme="dark"]',
    "system-dark": (f) => f.media === "media (prefers-color-scheme: dark)" && f.selector === '.fdn-chat[data-theme="system"]',
  };
  const map = new Map<string, string>();
  for (const f of flat.filter((x) => x.media === "" && x.selector === ".fdn-chat")) for (const d of f.decls) map.set(d.prop, d.value);
  if (theme !== "light") for (const f of flat.filter(wanted[theme])) for (const d of f.decls) map.set(d.prop, d.value);
  return map;
}

function colorSchemeOf(theme: Theme): string | undefined {
  return tokensOf(theme).get("color-scheme");
}

// ---- Contrast (WCAG 2.2) ----

function luminance(hex: string): number {
  const channel = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channel[0]! + 0.7152 * channel[1]! + 0.0722 * channel[2]!;
}
function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** `var(--fdn-x)` -> the theme's hex, or the literal colour; `undefined` for anything that is not a plain hex colour. */
function hexOf(value: string | undefined, theme: Theme): string | undefined {
  if (!value) return undefined;
  const m = /^var\((--fdn-[\w-]+)\)$/.exec(value.trim());
  const resolved = m ? tokensOf(theme).get(m[1]!) : value.trim();
  return resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : undefined;
}

// ---- Which rules reach an element ----

function specificity(selector: string): number {
  const bare = selector.replace(/::?[\w-]+\([^)]*\)/g, (m) => (m.startsWith(":not") ? m.slice(5, -1) : " :x"));
  const ids = (bare.match(/#[\w-]+/g) ?? []).length;
  const classes = (bare.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const types = (bare.replace(/\[[^\]]*\]/g, "").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

function matchesElement(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false; // a pseudo-class jsdom cannot evaluate (:focus-visible)
  }
}

/** The winning declaration of each property for the element (no media rules; the theme only changes tokens). */
function cascade(el: Element, pseudo = ""): Map<string, string> {
  const hits = flat.filter((f) => {
    if (f.media !== "") return false;
    const has = /::[\w-]+$/.exec(f.selector)?.[0] ?? "";
    if (has !== pseudo) return false;
    return matchesElement(el, pseudo ? f.selector.slice(0, -pseudo.length) : f.selector);
  });
  hits.sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order);
  const out = new Map<string, string>();
  for (const f of hits) {
    for (const d of f.decls) {
      // Shorthands count as their colour part.
      if (d.prop === "background" || d.prop === "background-color") out.set("background", d.value);
      else if (d.prop === "border" || d.prop === "border-color") out.set("border", d.value);
      else out.set(d.prop, d.value);
    }
  }
  return out;
}

const tokenIn = (value: string | undefined): string | undefined => /var\((--fdn-[\w-]+)\)/.exec(value ?? "")?.[1];

// ---- What every native control must have ----

interface Observed {
  /** `input[checkbox]`, `select`, `button.fdn-button.fdn-primary` ... */
  readonly kind: string;
  readonly text: string | undefined;
  readonly background: string | undefined;
  readonly border: string | undefined;
  readonly accent: string | undefined;
  readonly placeholder: string | undefined;
}
const observed = new Map<string, Observed>();

const FIELD_TYPES = new Set(["text", "url", "email", "password", "number", "search"]);

function kindOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return `input[${(el as HTMLInputElement).type}]`;
  if (tag === "button") return `button.${[...el.classList].filter((c) => c !== "fdn-selected").sort().join(".")}`;
  return tag;
}

function check(el: Element): void {
  const kind = kindOf(el);
  const c = cascade(el);
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" ? (el as HTMLInputElement).type : "";
  const at = `${kind} (${el.outerHTML.slice(0, 90)})`;

  // The text takes a palette token (or inherits the panel's), never the browser's default.
  const text = c.get("color");
  expect(text, `a text colour for ${at}`).toBeTruthy();
  expect(text === "inherit" || tokenIn(text) !== undefined, `a token text colour for ${at}: ${text}`).toBe(true);

  // Nothing removes the focus ring of a control.
  const outline = c.get("outline");
  expect(outline === undefined || tokenIn(outline) !== undefined, `the focus ring of ${at}: ${outline}`).toBe(true);

  let accent: string | undefined;
  let background: string | undefined;
  let border: string | undefined;
  let placeholder: string | undefined;

  if (type === "checkbox" || type === "radio") {
    accent = tokenIn(c.get("accent-color"));
    expect(accent, `accent-color for ${at}`).toBeTruthy();
  } else if (tag === "select" || tag === "textarea" || FIELD_TYPES.has(type)) {
    background = tokenIn(c.get("background"));
    border = tokenIn(c.get("border"));
    expect(background, `a background token for ${at}`).toBeTruthy();
    expect(border, `a border token for ${at}`).toBeTruthy();
    expect(border, `the boundary of ${at} is the control border`).toBe("--fdn-control-border");
    if (tag !== "select") {
      placeholder = tokenIn(cascade(el, "::placeholder").get("color"));
      expect(placeholder, `a placeholder colour for ${at}`).toBeTruthy();
    }
  } else if (tag === "button") {
    const bg = c.get("background");
    expect(bg === "transparent" || tokenIn(bg) !== undefined, `a background for ${at}: ${bg}`).toBe(true);
    background = tokenIn(bg);
  } else if (type === "file") {
    // Hidden behind the visible "Add" button (fdn-sr-only); never drawn.
    expect(el.classList.contains("fdn-sr-only")).toBe(true);
  } else {
    throw new Error(`a native control the test does not know: ${at}`);
  }

  if (tag === "select") {
    for (const option of el.querySelectorAll("option")) {
      const o = cascade(option);
      expect(tokenIn(o.get("background")), `a background for an option of ${at}`).toBeTruthy();
      expect(tokenIn(o.get("color")), `a colour for an option of ${at}`).toBeTruthy();
    }
    observed.set("option", { kind: "option", text: tokenIn(cascade(el.querySelector("option") ?? el).get("color")), background: tokenIn(cascade(el.querySelector("option") ?? el).get("background")), border: undefined, accent: undefined, placeholder: undefined });
  }

  observed.set(kind, { kind, text: text === "inherit" ? "--fdn-text" : tokenIn(text), background, border, accent, placeholder });
}

function checkAll(container: HTMLElement): void {
  for (const el of container.querySelectorAll("input, select, textarea, button")) check(el);
}

// ---- Render every state of every view ----

const harnesses: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

describe("native controls take the palette: every state of every view", () => {
  it.each(ALL_STEPS)("ConnectionWizard: %s", async (step) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, vm } = await reach(step, englishStrings);
    harnesses.push(h);
    const { container } = render(<ConnectionWizard wizard={vm} appName="Fadenstack Chrome" />);
    checkAll(container);
  });

  it.each(LIBRARY_STATES)("SkillLibrary: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, library } = await reachLibrary(state, englishStrings);
    harnesses.push(h);
    const { container } = render(<SkillLibrary library={library} />);
    checkAll(container);
  });

  it.each(EDITOR_STATES)("SkillEditor: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, editor } = await reachEditor(state, englishStrings);
    harnesses.push(h);
    const { container } = render(<SkillEditor editor={editor} />);
    checkAll(container);
  });

  it.each(DRAFT_STATES)("SkillDraft: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, draft } = await reachDraft(state, englishStrings);
    harnesses.push(h);
    const { container } = render(<SkillDraft draft={draft} />);
    checkAll(container);
  });
});

// ---- The Vue skin draws the same kinds of control ----

describe("native controls: the Vue skin", () => {
  it("uses no kind of control the React skin does not, and every kind is styled", () => {
    const dir = here("../../ui-vue/src/");
    const files = readdirSync(dir).filter((f) => f === "ConnectionWizard.vue" || (/^Skill.*\.vue$/.test(f) && f !== "SkillPicker.vue"));
    const kinds = new Set<string>();
    for (const f of files) {
      const source = readFileSync(dir + f, "utf8");
      for (const m of source.matchAll(/<(input|select|textarea|button)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
        const attrs = m[2]!;
        if (m[1] === "input") kinds.add(`input[${/\btype="(\w+)"/.exec(attrs)?.[1] ?? "text"}]`);
        else if (m[1] === "button") {
          // A bound `:class` ("fdn-button" plus "fdn-selected") is the plain button; "fdn-selected" is a state, not a kind.
          const classes = (/(?<![:\w-])class="([^"]*)"/.exec(attrs)?.[1] ?? "fdn-button").split(/\s+/).filter((c) => c && c !== "fdn-selected");
          kinds.add(`button.${classes.sort().join(".")}`);
        }
        else kinds.add(m[1]!);
      }
    }
    expect(kinds.size).toBeGreaterThan(5);
    // Observed by the React run above (tests in a file run in order).
    for (const kind of kinds) expect(observed.has(kind), `the React views draw ${kind}`).toBe(true);
  });
});

// ---- The stylesheet: every theme sets the colour scheme and the tokens; contrast per theme ----

describe("native controls: the themes", () => {
  it("every theme sets the colour scheme the browser's own parts follow", () => {
    expect(colorSchemeOf("light")).toBe("light");
    expect(colorSchemeOf("dark")).toBe("dark");
    expect(colorSchemeOf("system-dark")).toBe("dark");
  });

  it("the dark and the system-dark themes set the same tokens", () => {
    const dark = tokensOf("dark");
    const system = tokensOf("system-dark");
    for (const [k, v] of dark) expect(system.get(k), k).toBe(v);
  });

  it("every control the views draw was seen", () => {
    for (const kind of ["input[text]", "input[password]", "input[email]", "input[checkbox]", "input[number]", "select", "textarea", "option"]) {
      expect(observed.has(kind), kind).toBe(true);
    }
  });

  describe.each(THEMES)("contrast in %s", (theme) => {
    const hex = (token: string | undefined): string => {
      const v = hexOf(token ? `var(${token})` : undefined, theme);
      if (!v) throw new Error(`no colour for ${token} in ${theme}`);
      return v;
    };
    // A control sits on the panel's background or, inside a card or beside a read-only field, on the surface.
    const grounds = ["--fdn-bg", "--fdn-surface"];

    it("text in every control: 4.5:1 (1.4.3)", () => {
      for (const o of observed.values()) {
        const grounding = o.background ? [o.background] : grounds;
        for (const g of grounding) {
          const r = ratio(hex(o.text), hex(g));
          expect(r, `${o.kind}: ${o.text} on ${g} in ${theme}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it("quiet text in an empty box, read-only text and a disabled control's text: 4.5:1 (1.4.3)", () => {
      for (const o of observed.values()) {
        if (!o.placeholder) continue;
        for (const g of [o.background!, "--fdn-surface"]) {
          const r = ratio(hex(o.placeholder), hex(g));
          expect(r, `${o.kind} placeholder on ${g} in ${theme}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const g of ["--fdn-bg", "--fdn-surface"]) {
        expect(ratio(hex("--fdn-text-muted"), hex(g)), `muted on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("a field's boundary: 3:1 on the background and the surface (1.4.11)", () => {
      for (const o of observed.values()) {
        if (!o.border) continue;
        for (const g of grounds) {
          const r = ratio(hex(o.border), hex(g));
          expect(r, `${o.kind} border on ${g} in ${theme}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it("a ticked box (accent) and the focus ring: 3:1 (1.4.11)", () => {
      for (const o of observed.values()) {
        if (!o.accent) continue;
        for (const g of grounds) expect(ratio(hex(o.accent), hex(g)), `${o.kind} accent on ${g}`).toBeGreaterThanOrEqual(3);
      }
      const focus = tokensOf(theme).get("--fdn-focus");
      expect(focus).toBeTruthy();
      for (const g of grounds) expect(ratio(hex("--fdn-focus"), hex(g)), `focus on ${g}`).toBeGreaterThanOrEqual(3);
      const ring = flat.find((f) => f.selector === ".fdn-chat :focus-visible")!;
      expect(ring.decls.find((d) => d.prop === "outline")?.value).toContain("var(--fdn-focus)");
    });

    it("a primary button's text on its fill, and a plain button's text on the ground: 4.5:1 (1.4.3)", () => {
      expect(ratio(hex("--fdn-on-accent"), hex("--fdn-accent"))).toBeGreaterThanOrEqual(4.5);
      for (const g of grounds) expect(ratio(hex("--fdn-accent"), hex(g)), `accent text on ${g}`).toBeGreaterThanOrEqual(4.5);
    });
  });
});

afterAll(() => observed.clear());
