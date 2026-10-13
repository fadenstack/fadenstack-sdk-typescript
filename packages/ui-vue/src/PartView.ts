import { defineComponent, h, type Component, type PropType } from "vue";

import {
  ApprovalPart,
  CardPart,
  CitationsPart,
  DiffPart,
  MarkdownPart,
  NoticePart,
  ProgressPart,
  ReasoningPart,
  TablePart,
  ToolCallPart,
  type ResponsePart,
  type UiStrings,
} from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ApprovalView from "./parts/ApprovalView.vue";
import CardView from "./parts/CardView.vue";
import CitationsView from "./parts/CitationsView.vue";
import DiffView from "./parts/DiffView.vue";
import MarkdownView from "./parts/MarkdownView.vue";
import NoticeView from "./parts/NoticeView.vue";
import ProgressView from "./parts/ProgressView.vue";
import ReasoningView from "./parts/ReasoningView.vue";
import TableView from "./parts/TableView.vue";
import ToolCallView from "./parts/ToolCallView.vue";
import type { PartRenderer } from "./types.js";

const views: [abstract new (...args: never[]) => ResponsePart, Component][] = [
  [MarkdownPart, MarkdownView],
  [ToolCallPart, ToolCallView],
  [ApprovalPart, ApprovalView],
  [NoticePart, NoticeView],
  [ReasoningPart, ReasoningView],
  [CitationsPart, CitationsView],
  [CardPart, CardView],
  [TablePart, TableView],
  [ProgressPart, ProgressView],
  [DiffPart, DiffView],
];

/** One part of an answer: the host's renderers first, then the built-in view for its kind. */
export default defineComponent({
  name: "PartView",
  props: {
    part: { type: Object as PropType<ResponsePart>, required: true },
    strings: { type: Object as PropType<UiStrings>, required: true },
    renderers: { type: Array as PropType<readonly PartRenderer[]>, default: undefined },
  },
  setup(props) {
    // Watched here too, so a renderer is asked again when its part changes (a tool's result arrived).
    const part = useViewModel(() => props.part);
    return () => {
      for (const render of props.renderers ?? []) {
        const view = render(part.value, props.strings);
        if (view !== null && view !== undefined && view !== false) return view;
      }
      const view = views.find(([kind]) => part.value instanceof kind)?.[1];
      return view ? h(view, { part: part.value, strings: props.strings }) : null;
    };
  },
});
