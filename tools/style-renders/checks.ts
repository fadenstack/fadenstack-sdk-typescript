// The in-browser checks of tools/style-renders: contrast (WCAG 2.2 1.4.3 and 1.4.11), the radius system, the default look of controls,
// icons centred, and, in forced colours, visible boundaries. They run against the real computed styles of what is drawn.

export type Palette = "light" | "dark" | "forced";
export interface Failure { kind: string; where: string; detail: string }
export interface Stats {
  minText: { ratio: number; where: string } | undefined;
  minBoundary: { ratio: number; where: string } | undefined;
  minFocus: { ratio: number; where: string } | undefined;
}
type Rgba = [number, number, number, number];

const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

function rgba(css: string): Rgba {
  const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/.exec(css.trim());
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), a];
  }
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
}

const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const ch = (i: 0 | 1 | 2) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [ch(0), ch(1), ch(2), a];
};

function luminance(c: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function ratio(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** What is behind an element: the page's base, then every ancestor's background colour, from the top down (`self` includes the element's own). */
function backdrop(el: Element, base: Rgba, self: boolean): Rgba {
  const chain: Element[] = [];
  for (let e: Element | null = self ? el : el.parentElement; e; e = e.parentElement) chain.unshift(e);
  let bg: Rgba = base;
  for (const e of chain) {
    const c = rgba(getComputedStyle(e).backgroundColor);
    if (c[3] > 0) bg = over(c, bg);
  }
  return bg;
}

const opacityOf = (el: Element): number => {
  let o = 1;
  for (let e: Element | null = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
  return o;
};

function describe(el: Element): string {
  const cls = [...el.classList].map((c) => `.${c}`).join("");
  const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
  const type = el instanceof HTMLInputElement ? `[${el.type}]` : "";
  return `${el.tagName.toLowerCase()}${type}${cls}${label ? ` "${label}"` : ""}`;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 3 || r.height < 3) return false; // also the visually hidden file input
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}

const isControl = (el: Element): boolean => el.matches("button, input, select, textarea");
const isField = (el: Element): boolean =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit", "hidden"].includes(el.type));
const isCheck = (el: Element): boolean => el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");

const lineWidth = (s: CSSStyleDeclaration, side: "top" | "right" | "bottom" | "left"): number =>
  s.getPropertyValue(`border-${side}-style`) === "none" ? 0 : parseFloat(s.getPropertyValue(`border-${side}-width`));

/** A control's boundary: its border colour when it has one, else its fill, against what is behind it. */
function boundaryOf(el: Element, base: Rgba): { colour: Rgba; against: Rgba; how: string } {
  const s = getComputedStyle(el);
  const behind = backdrop(el, base, false);
  if (lineWidth(s, "top") > 0 && lineWidth(s, "bottom") > 0) {
    const c = rgba(s.borderTopColor);
    if (c[3] > 0) return { colour: over(c, behind), against: behind, how: "border" };
  }
  const fill = rgba(s.backgroundColor);
  return { colour: over(fill, behind), against: behind, how: "fill" };
}

export function runChecks(root: HTMLElement, palette: Palette): { failures: Failure[]; stats: Stats } {
  const failures: Failure[] = [];
  const stats: Stats = { minText: undefined, minBoundary: undefined, minFocus: undefined };
  const fail = (kind: string, el: Element | string, detail: string) =>
    failures.push({ kind, where: typeof el === "string" ? el : describe(el), detail });
  const forced = palette === "forced";
  const base: Rgba = palette === "dark" ? [31, 31, 31, 1] : [255, 255, 255, 1];
  const all = [...root.querySelectorAll("*")].filter((e) => !(e instanceof SVGElement && e.tagName.toLowerCase() !== "svg")).filter(visible);

  if (!forced) {
    // -- text, against what is actually behind it (1.4.3) --
    const ufo = (el: Element, colour: string, bg: Rgba, what: string) => {
      const s = getComputedStyle(el);
      const fg = rgba(colour);
      fg[3] *= opacityOf(el);
      const text = over(fg, bg);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
      const need = large ? 3 : 4.5;
      const r = ratio(text, bg);
      if (!stats.minText || r < stats.minText.ratio) stats.minText = { ratio: r, where: `${describe(el)} ${what}` };
      if (r < need) fail("text-contrast", el, `${what}: ${r.toFixed(2)}:1 needs ${need}:1 (${s.color} on rgb(${bg.slice(0, 3).map(Math.round)}))`);
    };
    for (const el of all) {
      if ((el as HTMLButtonElement).disabled) continue; // an inactive component is exempt (1.4.3)
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      if (direct || el instanceof HTMLInputElement && !isCheck(el) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const hasValue = !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || (el.value ?? "") !== "";
        if (direct || hasValue || el instanceof HTMLSelectElement) ufo(el, getComputedStyle(el).color, backdrop(el, base, true), "text");
      }
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder && el.value === "") {
        ufo(el, getComputedStyle(el, "::placeholder").color, backdrop(el, base, true), "placeholder");
      }
    }

    // -- boundaries of fields, check boxes, radios, switches, outlined buttons (1.4.11) --
    for (const el of all) {
      if ((el as HTMLButtonElement).disabled) continue;
      const outlined = el.matches("button.fdn-button:not(.fdn-primary):not(.fdn-quiet), button.fdn-suggestion");
      const filled = el.matches("button.fdn-button.fdn-primary");
      if (!(isField(el) || isCheck(el) || outlined || filled)) continue;
      const b = boundaryOf(el, base);
      const r = ratio(b.colour, b.against);
      if (!stats.minBoundary || r < stats.minBoundary.ratio) stats.minBoundary = { ratio: r, where: `${describe(el)} ${b.how}` };
      if (r < 3) fail("boundary-contrast", el, `${b.how} ${r.toFixed(2)}:1 needs 3:1`);
    }
  } else {
    // -- forced colours: no ratios, but every control keeps a visible boundary --
    for (const el of all) {
      if (!isControl(el) || (el instanceof HTMLInputElement && el.type === "file")) continue;
      const s = getComputedStyle(el);
      const border = lineWidth(s, "top") > 0 && lineWidth(s, "bottom") > 0 && lineWidth(s, "left") > 0 && lineWidth(s, "right") > 0 && rgba(s.borderTopColor)[3] > 0;
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const native = isCheck(el) && s.appearance !== "none";
      if (!border && !outline && !native) fail("forced-boundary", el, "no border or outline in forced colours");
    }
  }

  // -- the radius system: 0, 6, 8, 12, or a circle where the rule allows (round icon buttons, radio buttons, switch parts, the spinner) --
  const allowed = new Set([0, 6, 8, 12]);
  const roundOk = (el: Element) => el.matches(".fdn-icon-button, input[type=radio], [role=switch], .fdn-spinner");
  const seeRadius = (el: Element, pseudo: string | null) => {
    const s = getComputedStyle(el, pseudo);
    if (pseudo && (s.content === "none" || s.content === "normal")) return;
    const r = el.getBoundingClientRect();
    const hasFill = rgba(s.backgroundColor)[3] > 0 || s.backgroundImage !== "none";
    const hasLine = ["top", "right", "bottom", "left"].some((side) => lineWidth(s, side as "top") > 0);
    if (!hasFill && !hasLine && !(pseudo === null && el.matches(".fdn-spinner"))) return;
    for (const corner of ["top-left", "top-right", "bottom-right", "bottom-left"]) {
      const v = s.getPropertyValue(`border-${corner}-radius`);
      for (const part of v.split(/\s+/)) {
        if (part.endsWith("%")) {
          if (!(parseFloat(part) >= 50 && roundOk(el)) && parseFloat(part) !== 0) fail("radius", el, `${pseudo ?? ""} ${corner} ${v}`);
          continue;
        }
        const px = parseFloat(part);
        if (allowed.has(px)) continue;
        if (px >= Math.min(r.width, r.height) / 2 && roundOk(el)) continue;
        fail("radius", el, `${pseudo ?? ""} ${corner} ${v}`.trim());
      }
    }
  };
  // Which of the three each kind of element takes: controls 6, chips 8, cards and choice cards 12.
  const roleRadius = (el: Element): number | undefined => {
    if (el.matches("input[type=radio], [role=switch], .fdn-spinner")) return undefined;
    if (isField(el) || isCheck(el)) return 6;
    if (el.matches(".fdn-wizard-presets > button, .fdn-badge")) return 8;
    if (el.matches("button.fdn-suggestion")) return 12;
    if (el.matches("button.fdn-button")) return 6;
    return undefined;
  };
  for (const el of all) {
    const want = roleRadius(el);
    if (want !== undefined) {
      const got = getComputedStyle(el).borderTopLeftRadius;
      if (parseFloat(got) !== want || got.includes("%")) fail("radius-role", el, `radius ${got}, this kind takes ${want}px`);
    }
    seeRadius(el, null);
    seeRadius(el, "::before");
    seeRadius(el, "::after");
  }

  // -- no browser default look --
  const probe = document.createElement("div");
  probe.style.backgroundColor = "ButtonFace";
  root.appendChild(probe);
  const buttonFace = rgba(getComputedStyle(probe).backgroundColor);
  probe.remove();
  for (const el of all) {
    if (!isControl(el)) continue;
    const s = getComputedStyle(el);
    for (const side of ["top", "right", "bottom", "left"]) {
      const style = s.getPropertyValue(`border-${side}-style`);
      if (["inset", "outset", "groove", "ridge"].includes(style)) fail("ua-look", el, `border-${side}-style ${style}`);
    }
    if (!forced && el instanceof HTMLButtonElement) {
      const bg = rgba(s.backgroundColor);
      if (bg[3] === 1 && bg[0] === buttonFace[0] && bg[1] === buttonFace[1] && bg[2] === buttonFace[2]) fail("ua-look", el, "the UA's buttonface grey");
    }
    if (!forced && (el instanceof HTMLSelectElement || isCheck(el)) && s.appearance !== "none") fail("ua-look", el, `appearance: ${s.appearance}`);
    if (!forced && el instanceof HTMLSelectElement === false && !(el instanceof HTMLButtonElement) && !isCheck(el) && isField(el)) {
      if (s.borderTopStyle === "none" || parseFloat(s.borderTopWidth) === 0) fail("ua-look", el, "a field with no border");
    }
    if (el instanceof HTMLInputElement && el.type === "file" && !el.classList.contains("fdn-sr-only")) fail("ua-look", el, "an unstyled file input");
  }

  // -- icons centred in their square buttons --
  for (const el of all) {
    if (!(el instanceof HTMLButtonElement)) continue;
    const svg = el.querySelector("svg");
    if (!svg) continue;
    const b = el.getBoundingClientRect();
    if (Math.abs(b.width - b.height) > 1 || (el.textContent ?? "").trim() !== "") continue;
    const i = svg.getBoundingClientRect();
    const dx = Math.abs(i.left + i.width / 2 - (b.left + b.width / 2));
    const dy = Math.abs(i.top + i.height / 2 - (b.top + b.height / 2));
    if (dx > 0.5 || dy > 0.5) fail("icon-centre", el, `off by ${dx.toFixed(2)} / ${dy.toFixed(2)} px`);
  }
  return { failures, stats };
}

const TABBABLE = "button, a[href], input, select, textarea, [tabindex]";

export function tabbableCount(root: HTMLElement): number {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && visible(e)).length;
}

/** The focus ring of the element that has the focus now (after a Tab): its colour against what is around the element. */
export function measureFocus(root: HTMLElement): { where: string; ring: boolean; ratio: number | undefined; width: number; style: string; self: string } | null {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !(el instanceof HTMLElement)) return null;
  const s = getComputedStyle(el);
  const dark = root.querySelector('[data-theme="dark"]') !== null ||
    (root.querySelector('[data-theme="system"]') !== null && matchMedia("(prefers-color-scheme: dark)").matches);
  const base: Rgba = dark ? [31, 31, 31, 1] : [255, 255, 255, 1];
  const width = parseFloat(s.outlineWidth);
  const ring = s.outlineStyle !== "none" && width > 0 && el.matches(":focus-visible");
  const colour = rgba(s.outlineColor);
  const around = backdrop(el, base, false);
  const r = ring ? ratio(over(colour, around), around) : undefined;
  return { where: describe(el), ring, ratio: r, width, style: s.outlineStyle, self: s.outlineColor };
}
