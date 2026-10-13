import type { VNodeChild } from "vue";

import type { ResponsePart, UiStrings } from "@fadenstack/ui";

export type ChatTheme = "system" | "light" | "dark";

/**
 * A view for parts a module adds, tried before the built-in ones and again whenever the part changes. Return what
 * to draw (`h(MyCard, { part })`; the built-in views, e.g. `ToolCallView`, take `{ part, strings }`), or nothing
 * to pass.
 */
export type PartRenderer = (part: ResponsePart, strings: UiStrings) => VNodeChild | null | undefined;
