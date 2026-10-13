import { defineComponent, h, useId, type PropType, type VNode } from "vue";

import { agentAvatar, type SvgNode } from "@fadenstack/ui-web";

/**
 * The agent's face: the Fadenstack "stack" -- three plates, the rose middle one is the thread, and two eyes peek
 * out from under the top plate. The drawing is @fadenstack/ui-web's, so every skin draws the same SVG; it scales
 * and follows the panel's theme tokens (`--fdn-agent-*`). A `class` goes on the `<svg>`.
 */
export default defineComponent({
  name: "AgentAvatar",
  props: {
    /** Pixels (56 by default). Up to 32 px the small cut is drawn: bigger eyes, the top plate raised, no loose thread end. */
    size: { type: Number, default: undefined },
    /** `mono` draws one colour (`currentColor`): eyes are rings with a pupil, overlaps are transparent gaps. */
    variant: { type: String as PropType<"color" | "mono">, default: undefined },
    /** A custom agent's own thread colour for the middle plate. Fadenstack's own agents keep the rose. */
    color: { type: String, default: undefined },
    /** Read out by screen readers; without it the avatar is decorative. */
    label: { type: String, default: undefined },
  },
  setup(props) {
    const id = useId();
    return () => toVNode(agentAvatar({ size: props.size, variant: props.variant, color: props.color, label: props.label, idPrefix: id }));
  },
});

function toVNode(node: SvgNode): VNode {
  return h(node.tag, node.style ? { ...node.attrs, style: node.style } : node.attrs, node.children?.map(toVNode));
}
