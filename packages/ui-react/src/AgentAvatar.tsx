/**
 * The agent's face: the Fadenstack "stack" -- three plates, the rose middle one is the thread, and two eyes peek
 * out from under the top plate. The drawing is @fadenstack/ui-web's, so every skin draws the same SVG; it scales
 * and follows the panel's theme tokens (`--fdn-agent-*`).
 */
import { createElement, useId, type CSSProperties, type ReactElement } from "react";

import { agentAvatar, type AgentAvatarOptions, type SvgNode } from "@fadenstack/ui-web";

export type AgentAvatarProps = Omit<AgentAvatarOptions, "idPrefix">;

export function AgentAvatar(props: AgentAvatarProps): ReactElement {
  return toElement(agentAvatar({ ...props, idPrefix: useId() }));
}

/** SVG attribute names as React spells them: `stroke-width` is `strokeWidth`, `class` is `className`. */
function reactName(name: string): string {
  if (name === "class") return "className";
  if (name.startsWith("aria-") || name.startsWith("data-")) return name;
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toElement(node: SvgNode, key?: number): ReactElement {
  const props: Record<string, unknown> = key === undefined ? {} : { key };
  for (const [name, value] of Object.entries(node.attrs)) props[reactName(name)] = value;
  if (node.style) props["style"] = node.style as CSSProperties;
  return createElement(node.tag, props, ...(node.children ?? []).map((child, i) => toElement(child, i)));
}
