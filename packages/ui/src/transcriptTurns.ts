import { EntryTypes, TurnStatus, type ApprovalRequest, type TranscriptEntry } from "@fadenstack/agents";
import { parseToolClass, type ChatOutcome } from "@fadenstack/client";

import { formatNumber } from "./format.js";
import { ApprovalPart, NoticePart, type ApprovalState, type PartContext } from "./parts.js";
import { TurnViewModel, type TurnHost, type TurnState } from "./turn.js";

type Data = Record<string, unknown>;
const str = (d: unknown, k: string): string | undefined => {
  const v = d && typeof d === "object" ? (d as Data)[k] : undefined;
  return typeof v === "string" ? v : undefined;
};

/** A session's entries grouped by turn, oldest first. */
export function groupTurns(entries: readonly TranscriptEntry[]): TranscriptEntry[][] {
  const order: TranscriptEntry[][] = [];
  const byId = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    if (!entry.turnId) continue;
    let list = byId.get(entry.turnId);
    if (!list) {
      list = [];
      byId.set(entry.turnId, list);
      order.push(list);
    }
    list.push(entry);
  }
  return order;
}

/** One turn read back from the transcript. */
export function buildTurn(entries: readonly TranscriptEntry[], context: PartContext, host: TurnHost | undefined): TurnViewModel {
  const user = entries.find((e) => e.type === EntryTypes.userMessage);
  const attachments = Array.isArray(user?.data["attachments"])
    ? (user!.data["attachments"] as Data[]).map((a) => ({ title: str(a, "title") ?? "", subtitle: str(a, "kind") }))
    : [];
  const turn = new TurnViewModel(context, host, str(user?.data, "text") ?? "", new Date((user ?? entries[0]!).timestamp),
    attachments, "completed");
  turn.setId(entries[0]!.turnId!);
  let state: TurnState = "stopped"; // a turn without an end was interrupted
  let outcome: ChatOutcome | undefined;
  let usage = "";
  for (const entry of entries) {
    const d = entry.data;
    switch (entry.type) {
      case EntryTypes.assistantMessage: {
        const text = str(d, "text");
        if (text) turn.addRestoredText(text);
        if (str(d, "origin") === "gateway" && Array.isArray(d["tool_calls"])) {
          for (const call of d["tool_calls"] as Data[]) turn.addRestoredTool(str(call, "id") ?? "", str(call, "name") ?? "", "gateway", "read");
        }
        break;
      }
      case EntryTypes.toolStart:
        turn.addRestoredTool(str(d, "call_id") ?? "", str(d, "name") ?? "", str(d, "source") ?? "host", parseToolClass(str(d, "tool_class")));
        break;
      case EntryTypes.toolComplete: {
        const callId = str(d, "call_id") ?? "";
        const name = str(d, "name") ?? "";
        const part = turn.findTool(callId, name) ?? turn.addRestoredTool(callId, name, str(d, "source") ?? "host", "unknown");
        part.complete(str(d, "outcome") ?? "ok", str(d, "result"), typeof d["duration_ms"] === "number" ? (d["duration_ms"] as number) : 0);
        break;
      }
      case EntryTypes.approvalDecision: {
        if (d["asked"] === false) break; // let through by this chat's, an always or a bypass approval: no card, as live
        const request: ApprovalRequest = {
          callId: str(d, "call_id") ?? "", toolName: str(d, "name") ?? "", toolClass: "unknown",
          source: str(d, "source") ?? "host", reason: "", arguments: {},
        };
        const decided: ApprovalState = d["timed_out"] === true ? "expired" : d["approved"] !== true ? "denied"
          : d["scope"] === "always" ? "approved_always" : d["for_session"] === true ? "approved_for_session" : "approved";
        turn.addApprovalPart(new ApprovalPart(context, request, decided));
        break;
      }
      case EntryTypes.governanceNotice: {
        const notice = { outcome: str(d, "outcome") ?? "", message: str(d, "message") ?? "" } as Parameters<typeof NoticePart.from>[0];
        const decisionId = str(d, "decision_id");
        if (decisionId) notice.decisionId = decisionId;
        turn.addRestoredPart(NoticePart.from(notice, context.strings));
        break;
      }
      case EntryTypes.turnEnd: {
        state = entry.status === TurnStatus.promptBlocked ? "blocked" : entry.status === TurnStatus.error ? "failed"
          : entry.status === TurnStatus.cancelled ? "stopped" : "completed";
        outcome = (str(d, "outcome") as ChatOutcome | undefined) ?? undefined;
        const total = (d["usage"] as Data | null)?.["total_tokens"];
        if (typeof total === "number" && total > 0) usage = context.strings.tokens(formatNumber(total, context.locale));
        break;
      }
    }
  }
  turn.restore(state, outcome, usage);
  return turn;
}
