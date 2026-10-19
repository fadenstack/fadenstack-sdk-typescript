import { RECEIPT_EVENT, eventKind, type FadenstackEvent } from "@fadenstack/client";

import { CitationsPart, NoticePart, type Citation, type PartContext } from "./parts.js";
import type { TurnViewModel } from "./turn.js";

/**
 * Turns a gateway event into parts of the answer. Core renders citations, PII notices and, for an event it does
 * not know, a generic notice (so a UI shows an extension's events sensibly before it knows them). Modules add their own
 * through `AgentChatOptions.renderers`; the first that handles an event wins.
 */
export interface AgentEventRenderer {
  render(event: FadenstackEvent, turn: TurnViewModel, context: PartContext): boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

export const citationsRenderer: AgentEventRenderer = {
  render(event, turn, context) {
    if (eventKind(event) !== "faden.citations") return false;
    const sources = obj(event.value)?.["sources"];
    const citations: Citation[] = (Array.isArray(sources) ? sources : []).map((s: unknown) => {
      const source = obj(s) ?? {};
      const citation: Citation = {
        title: String(source["source"] ?? source["document_id"] ?? context.strings.source),
      };
      if (typeof source["chunk"] === "number") citation.detail = context.strings.part(source["chunk"]);
      if (typeof source["score"] === "number") citation.score = source["score"];
      return citation;
    });
    if (!citations.length) return true;
    const last = turn.parts[turn.parts.length - 1];
    if (last instanceof CitationsPart) last.add(citations);
    else turn.addPart(new CitationsPart(context, citations));
    return true;
  },
};

export const piiRenderer: AgentEventRenderer = {
  render(event, turn, context) {
    if (eventKind(event) !== "faden.pii") return false;
    const entities = obj(obj(event.value)?.["entities"]);
    const found = Object.entries(entities ?? {})
      .map(([type, count]) => ({ type: type.replace(/_/g, " ").toLowerCase(), count: typeof count === "number" ? count : 0 }))
      .filter((f) => f.count > 0);
    if (found.length) {
      const total = found.reduce((n, f) => n + f.count, 0);
      const list = found.map((f) => `${f.count} ${f.type}`).join(", ");
      turn.addPart(NoticePart.localized(context, "info", (s) => ({ title: s.piiTitle, message: s.piiMessage(total, list) })));
    }
    return true;
  },
};

/**
 * Events the chat shows elsewhere or not at all, and a generic notice for anything else. An answer's receipt
 * (`faden.provenance`) is kept with the turn by the session; it is no message for the user.
 */
const HANDLED = new Set(["TOOL_CALL_START", "TOOL_CALL_END", "faden.gateway_round", "faden.approval_required",
  "faden.tool_denied", "faden.governance", "faden.tool_mode", RECEIPT_EVENT]);

export const fallbackRenderer: AgentEventRenderer = {
  render(event, turn, context) {
    if (HANDLED.has(eventKind(event)) || event.type !== "CUSTOM") return true;
    const message = obj(event.value)?.["message"];
    const text = typeof message === "string" ? message : eventKind(event);
    turn.addPart(NoticePart.localized(context, "info", (s) => ({ title: s.noticeFallback, message: text })));
    return true;
  },
};
