/**
 * The agent's face: the Fadenstack "stack" -- three plates, the rose middle one is the thread, and two eyes peek
 * out from under the top plate. Drawn inline from the brand geometry (brand/avatar/make_agent_avatar.py), so it
 * scales and follows the panel's theme tokens (`--fdn-agent-*`).
 */
import { useId, type CSSProperties, type ReactElement } from "react";

export interface AgentAvatarProps {
  /** Pixels. Up to 32 px the small cut is drawn: bigger eyes, the top plate raised, no loose thread end. */
  size?: number;
  /** `mono` draws one colour (`currentColor`): eyes are rings with a pupil, overlaps are transparent gaps. */
  variant?: "color" | "mono";
  /** A custom agent's own thread colour for the middle plate. Fadenstack's own agents keep the rose. */
  color?: string;
  /** Read out by screen readers; without it the avatar is decorative. */
  label?: string;
  className?: string;
}

const W = 58, H = 29, T = 9, MID = 122, BOT = 146;
const TAIL = "M152 128 C168 132 176 148 168 160";

const CUTS = {
  full: { view: "21 30 158 158", lid: 62, eyes: [88, 112], rx: 8, ry: 9.5, outline: 2, pupil: 4.2, glint: 1.4, ring: 3.6, mpupil: 4.6, gap: 4 },
  small: { view: "19.5 25 161 161", lid: 56, eyes: [84, 116], rx: 11, ry: 12.5, outline: 3, pupil: 5.8, glint: 1.9, ring: 6, mpupil: 6.4, gap: 6 },
} as const;
const EYE_Y = 104;

const poly = (points: readonly (readonly [number, number])[]) => `M${points.map(([x, y]) => `${x} ${y}`).join(" L")} Z`;

function plate(cy: number) {
  return {
    top: poly([[100, cy - H], [100 + W, cy], [100, cy + H], [100 - W, cy]]),
    left: poly([[100 - W, cy], [100, cy + H], [100, cy + H + T], [100 - W, cy + T]]),
    right: poly([[100, cy + H], [100 + W, cy], [100 + W, cy + T], [100, cy + H + T]]),
    outline: poly([[100 - W, cy], [100, cy - H], [100 + W, cy], [100 + W, cy + T], [100, cy + H + T], [100 - W, cy + T]]),
  };
}

const solid = (fill: string): CSSProperties => ({ fill, stroke: fill, strokeWidth: 3, strokeLinejoin: "round" });

export function AgentAvatar({ size = 56, variant = "color", color, label, className }: AgentAvatarProps): ReactElement {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const small = size <= 32;
  const k = small ? CUTS.small : CUTS.full;
  const bottom = plate(BOT), middle = plate(MID), lid = plate(k.lid);
  const style = color
    ? ({ "--fdn-agent-thread": color, "--fdn-agent-thread-side": `color-mix(in srgb, ${color} 72%, #000)` } as CSSProperties)
    : undefined;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };

  if (variant === "mono") {
    const full = <rect x="0" y="0" width="200" height="200" fill="#fff" />;
    const grow = { fill: "#000", stroke: "#000", strokeWidth: k.gap * 2, strokeLinejoin: "round" as const };
    const erx = k.rx + k.ring / 2 + k.gap, ery = k.ry + k.ring / 2 + k.gap;
    const mask = (suffix: string, children: ReactElement | ReactElement[]) => (
      <mask id={`${id}${suffix}`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">{full}{children}</mask>
    );
    return (
      <svg className={`fdn-agent-avatar${className ? ` ${className}` : ""}`} width={size} height={size} viewBox={k.view} focusable="false" {...a11y}>
        <defs>
          {mask("b", [<path key="m" d={middle.outline} {...grow} />,
            ...(small ? [] : [<path key="t" d={TAIL} fill="none" stroke="#000" strokeWidth={6 + k.gap * 2} strokeLinecap="round" />])])}
          {mask("m", [<path key="l" d={lid.outline} {...grow} />,
            ...k.eyes.map((x) => <ellipse key={x} cx={x} cy={EYE_Y} rx={erx} ry={ery} fill="#000" />)])}
          {mask("e", <path d={lid.outline} {...grow} />)}
        </defs>
        <g fill="currentColor" stroke="currentColor" strokeLinejoin="round">
          <path d={bottom.outline} strokeWidth={3} mask={`url(#${id}b)`} />
          {!small && <path d={TAIL} fill="none" strokeWidth={6} strokeLinecap="round" />}
          <path d={middle.outline} strokeWidth={3} mask={`url(#${id}m)`} />
          <g mask={`url(#${id}e)`}>
            {k.eyes.map((x) => (
              <g key={x}>
                <ellipse cx={x} cy={EYE_Y} rx={k.rx} ry={k.ry} fill="none" strokeWidth={k.ring} />
                <circle cx={x + 1} cy={EYE_Y - 1.5} r={k.mpupil} stroke="none" />
              </g>
            ))}
          </g>
          <path d={lid.outline} strokeWidth={3} />
        </g>
      </svg>
    );
  }

  return (
    <svg className={`fdn-agent-avatar${className ? ` ${className}` : ""}`} width={size} height={size} viewBox={k.view} focusable="false" style={style} {...a11y}>
      <path d={bottom.left} style={solid("var(--fdn-agent-plate-side, #0A0E1A)")} />
      <path d={bottom.right} style={solid("var(--fdn-agent-plate-side, #0A0E1A)")} />
      <path d={bottom.top} style={solid("var(--fdn-agent-plate, #1C2436)")} />
      {!small && <path d={TAIL} fill="none" style={{ stroke: "var(--fdn-agent-thread, #E2325A)", strokeWidth: 6, strokeLinecap: "round" }} />}
      <path d={middle.left} style={solid("var(--fdn-agent-thread-side, #A8143E)")} />
      <path d={middle.right} style={solid("var(--fdn-agent-thread-side, #A8143E)")} />
      <path d={middle.top} style={solid("var(--fdn-agent-thread, #E2325A)")} />
      {!small && <ellipse cx="100" cy="110" rx="34" ry="11" style={{ fill: "var(--fdn-agent-hollow, rgba(10, 14, 26, 0.38))" }} />}
      {k.eyes.map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={EYE_Y} rx={k.rx} ry={k.ry} style={{ fill: "var(--fdn-agent-eye, #FFFFFF)", stroke: "var(--fdn-agent-pupil, #0A0E1A)", strokeWidth: k.outline }} />
          <circle cx={x + 1} cy={EYE_Y - 1.5} r={k.pupil} style={{ fill: "var(--fdn-agent-pupil, #0A0E1A)" }} />
          <circle cx={x + 2.6} cy={EYE_Y - 1.5 - k.pupil * 0.45} r={k.glint} style={{ fill: "var(--fdn-agent-eye, #FFFFFF)" }} />
        </g>
      ))}
      <path d={lid.left} style={solid("var(--fdn-agent-plate-side, #0A0E1A)")} />
      <path d={lid.right} style={solid("var(--fdn-agent-plate-side, #0A0E1A)")} />
      <path d={lid.top} style={solid("var(--fdn-agent-plate, #1C2436)")} />
    </svg>
  );
}
