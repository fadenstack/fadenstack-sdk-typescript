import { h, type FunctionalComponent, type VNodeArrayChildren } from "vue";

import type { Inline, UiStrings } from "@fadenstack/ui";

/** A block's inline Markdown as elements -- never as HTML. A render function, so no whitespace comes between them. */
const Inlines: FunctionalComponent<{ inlines: readonly Inline[]; strings: UiStrings }> = (props) => render(props.inlines, props.strings);
Inlines.props = ["inlines", "strings"];
export default Inlines;

function render(list: readonly Inline[], strings: UiStrings): VNodeArrayChildren {
  return list.map((inline) => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "strong":
        return h("strong", render(inline.children, strings));
      case "em":
        return h("em", render(inline.children, strings));
      case "del":
        return h("del", render(inline.children, strings));
      case "code":
        return h("code", inline.text);
      case "link":
        return h("a", { href: inline.href, target: "_blank", rel: "noopener noreferrer", title: inline.href }, render(inline.children, strings));
      case "image":
        // Never loaded: a remote image can carry data out. Its alt text, and where it is.
        return h("span", { class: "fdn-md-image", title: inline.href }, `[${inline.alt || strings.image}]`);
      case "break":
        return h("br");
    }
  });
}
