/**
 * The agent's face: the Fadenstack "stack" -- three plates, the rose middle one is the thread, and two eyes peek
 * out from under the top plate. Drawn from the brand geometry (brand/avatar/make_agent_avatar.py) as data, so
 * every skin draws the same SVG; it scales and follows the panel's theme tokens (`--fdn-agent-*`).
 */

/** An SVG element as data, which a skin turns into its own elements (React's `createElement`, Vue's `h`). */
export interface SvgNode {
  tag: string;
  /** Attributes as SVG spells them ("stroke-width", "viewBox", "class"), in the order they are written. */
  attrs: Readonly<Record<string, string | number>>;
  /** Inline style: camelCase properties and custom properties ("--fdn-agent-thread"). */
  style?: Readonly<Record<string, string | number>>;
  children?: readonly SvgNode[];
}

export interface AgentAvatarOptions {
  /** Pixels. Up to 32 px the small cut is drawn: bigger eyes, the top plate raised, no loose thread end. */
  size?: number;
  /** `mono` draws one colour (`currentColor`): eyes are rings with a pupil, overlaps are transparent gaps. */
  variant?: "color" | "mono";
  /** A custom agent's own thread colour for the middle plate. Fadenstack's own agents keep the rose. */
  color?: string;
  /** Read out by screen readers; without it the avatar is decorative. */
  label?: string;
  className?: string;
  /** Unique on the page (React's `useId`, Vue's `useId`): the mono variant's masks are named after it. */
  idPrefix: string;
}

const W = 58, H = 29, T = 9, MID = 122, BOT = 146;
const TAIL = "M152 128 C168 132 176 148 168 160";
const EYE_Y = 104;

const CUTS = {
  full: { view: "21 30 158 158", lid: 62, eyes: [88, 112], rx: 8, ry: 9.5, outline: 2, pupil: 4.2, glint: 1.4, ring: 3.6, mpupil: 4.6, gap: 4 },
  small: { view: "19.5 25 161 161", lid: 56, eyes: [84, 116], rx: 11, ry: 12.5, outline: 3, pupil: 5.8, glint: 1.9, ring: 6, mpupil: 6.4, gap: 6 },
} as const;

const poly = (points: readonly (readonly [number, number])[]) => `M${points.map(([x, y]) => `${x} ${y}`).join(" L")} Z`;

function plate(cy: number) {
  return {
    top: poly([[100, cy - H], [100 + W, cy], [100, cy + H], [100 - W, cy]]),
    left: poly([[100 - W, cy], [100, cy + H], [100, cy + H + T], [100 - W, cy + T]]),
    right: poly([[100, cy + H], [100 + W, cy], [100 + W, cy + T], [100, cy + H + T]]),
    outline: poly([[100 - W, cy], [100, cy - H], [100 + W, cy], [100 + W, cy + T], [100, cy + H + T], [100 - W, cy + T]]),
  };
}

const node = (tag: string, attrs: SvgNode["attrs"], children?: readonly SvgNode[], style?: SvgNode["style"]): SvgNode =>
  ({ tag, attrs, ...(style ? { style } : {}), ...(children ? { children } : {}) });
const solid = (d: string, fill: string): SvgNode => node("path", { d }, undefined, { fill, stroke: fill, strokeWidth: 3, strokeLinejoin: "round" });

/** The avatar's `<svg>`. */
export function agentAvatar({ size = 56, variant = "color", color, label, className, idPrefix }: AgentAvatarOptions): SvgNode {
  const id = idPrefix.replace(/[^a-zA-Z0-9_-]/g, "");
  const small = size <= 32;
  const k = small ? CUTS.small : CUTS.full;
  const bottom = plate(BOT), middle = plate(MID), lid = plate(k.lid);
  const a11y: Record<string, string> = label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" };
  const svg = {
    class: `fdn-agent-avatar${className ? ` ${className}` : ""}`,
    width: size,
    height: size,
    viewBox: k.view,
    focusable: "false",
  };

  if (variant === "mono") {
    const full = node("rect", { x: "0", y: "0", width: "200", height: "200", fill: "#fff" });
    const grow = { fill: "#000", stroke: "#000", "stroke-width": k.gap * 2, "stroke-linejoin": "round" };
    const erx = k.rx + k.ring / 2 + k.gap, ery = k.ry + k.ring / 2 + k.gap;
    const mask = (suffix: string, children: readonly SvgNode[]) =>
      node("mask", { id: `${id}${suffix}`, maskUnits: "userSpaceOnUse", x: "0", y: "0", width: "200", height: "200" }, [full, ...children]);
    return node("svg", { ...svg, ...a11y }, [
      node("defs", {}, [
        mask("b", [node("path", { d: middle.outline, ...grow }),
          ...(small ? [] : [node("path", { d: TAIL, fill: "none", stroke: "#000", "stroke-width": 6 + k.gap * 2, "stroke-linecap": "round" })])]),
        mask("m", [node("path", { d: lid.outline, ...grow }),
          ...k.eyes.map((x) => node("ellipse", { cx: x, cy: EYE_Y, rx: erx, ry: ery, fill: "#000" }))]),
        mask("e", [node("path", { d: lid.outline, ...grow })]),
      ]),
      node("g", { fill: "currentColor", stroke: "currentColor", "stroke-linejoin": "round" }, [
        node("path", { d: bottom.outline, "stroke-width": 3, mask: `url(#${id}b)` }),
        ...(small ? [] : [node("path", { d: TAIL, fill: "none", "stroke-width": 6, "stroke-linecap": "round" })]),
        node("path", { d: middle.outline, "stroke-width": 3, mask: `url(#${id}m)` }),
        node("g", { mask: `url(#${id}e)` }, k.eyes.map((x) => node("g", {}, [
          node("ellipse", { cx: x, cy: EYE_Y, rx: k.rx, ry: k.ry, fill: "none", "stroke-width": k.ring }),
          node("circle", { cx: x + 1, cy: EYE_Y - 1.5, r: k.mpupil, stroke: "none" }),
        ]))),
        node("path", { d: lid.outline, "stroke-width": 3 }),
      ]),
    ]);
  }

  const style = color ? { "--fdn-agent-thread": color, "--fdn-agent-thread-side": `color-mix(in srgb, ${color} 72%, #000)` } : undefined;
  const plateSide = "var(--fdn-agent-plate-side, #0A0E1A)", plateTop = "var(--fdn-agent-plate, #1C2436)";
  const threadSide = "var(--fdn-agent-thread-side, #A8143E)", thread = "var(--fdn-agent-thread, #E2325A)";
  return node("svg", { ...svg, ...a11y }, [
    solid(bottom.left, plateSide),
    solid(bottom.right, plateSide),
    solid(bottom.top, plateTop),
    ...(small ? [] : [node("path", { d: TAIL, fill: "none" }, undefined, { stroke: thread, strokeWidth: 6, strokeLinecap: "round" })]),
    solid(middle.left, threadSide),
    solid(middle.right, threadSide),
    solid(middle.top, thread),
    ...(small ? [] : [node("ellipse", { cx: "100", cy: "110", rx: "34", ry: "11" }, undefined, { fill: "var(--fdn-agent-hollow, rgba(10, 14, 26, 0.38))" })]),
    ...k.eyes.map((x) => node("g", {}, [
      node("ellipse", { cx: x, cy: EYE_Y, rx: k.rx, ry: k.ry }, undefined,
        { fill: "var(--fdn-agent-eye, #FFFFFF)", stroke: "var(--fdn-agent-pupil, #0A0E1A)", strokeWidth: k.outline }),
      node("circle", { cx: x + 1, cy: EYE_Y - 1.5, r: k.pupil }, undefined, { fill: "var(--fdn-agent-pupil, #0A0E1A)" }),
      node("circle", { cx: x + 2.6, cy: EYE_Y - 1.5 - k.pupil * 0.45, r: k.glint }, undefined, { fill: "var(--fdn-agent-eye, #FFFFFF)" }),
    ])),
    solid(lid.left, plateSide),
    solid(lid.right, plateSide),
    solid(lid.top, plateTop),
  ], style);
}
