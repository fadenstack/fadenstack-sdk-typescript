import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type * as Core from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { agUiEvents, agUiJson, type AgentEvent, type AgUiEvent, type ApprovalRequest } from "@fadenstack/agents";
import type * as Ours from "../src/aguiTypes.js";

// AG-UI events (sdk/51 F07): the golden files in test/agui are the same bytes as the .NET SDK's
// tests/Fadenstack.Agents.Tests/AgUi, one JSON event per line. Set FADEN_UPDATE_GOLDEN=1 to write them.

// Type-level parity with @ag-ui/core 1.0.4 (a dev dependency): each of our interfaces must be assignable to the wire shape
// of the matching core type (`type` as the plain string), and must carry no key core does not know. A drift fails `tsc`.
type Wire<E extends { type: string }> = Omit<E, "type"> & { type: `${E["type"]}` };
type Fits<O, C> = [O] extends [C] ? ([keyof O] extends [keyof C] ? true : false) : false;
type Assert<T extends true> = T;
export type ParityChecks = [
  Assert<Fits<Ours.RunStartedEvent, Wire<Core.RunStartedEvent>>>,
  Assert<Fits<Ours.RunFinishedEvent, Wire<Core.RunFinishedEvent>>>,
  Assert<Fits<Ours.RunErrorEvent, Wire<Core.RunErrorEvent>>>,
  Assert<Fits<Ours.TextMessageStartEvent, Wire<Core.TextMessageStartEvent>>>,
  Assert<Fits<Ours.TextMessageContentEvent, Wire<Core.TextMessageContentEvent>>>,
  Assert<Fits<Ours.TextMessageEndEvent, Wire<Core.TextMessageEndEvent>>>,
  Assert<Fits<Ours.ReasoningStartEvent, Wire<Core.ReasoningStartEvent>>>,
  Assert<Fits<Ours.ReasoningMessageStartEvent, Wire<Core.ReasoningMessageStartEvent>>>,
  Assert<Fits<Ours.ReasoningMessageContentEvent, Wire<Core.ReasoningMessageContentEvent>>>,
  Assert<Fits<Ours.ReasoningMessageEndEvent, Wire<Core.ReasoningMessageEndEvent>>>,
  Assert<Fits<Ours.ReasoningEndEvent, Wire<Core.ReasoningEndEvent>>>,
  Assert<Fits<Ours.ToolCallStartEvent, Wire<Core.ToolCallStartEvent>>>,
  Assert<Fits<Ours.ToolCallArgsEvent, Wire<Core.ToolCallArgsEvent>>>,
  Assert<Fits<Ours.ToolCallEndEvent, Wire<Core.ToolCallEndEvent>>>,
  Assert<Fits<Ours.ToolCallResultEvent, Wire<Core.ToolCallResultEvent>>>,
  Assert<Fits<Ours.CustomEvent, Wire<Core.CustomEvent>>>,
  Assert<Fits<Ours.Interrupt, Core.Interrupt>>,
  Assert<Fits<Ours.TokenUsage, Core.TokenUsage>>,
  Assert<Fits<Ours.RunFinishedOutcome, Core.RunFinishedOutcome>>,
  // The union has exactly the sixteen core event types the adapter emits.
  Assert<[Ours.AgUiEvent["type"]] extends [`${Core.EventType}`] ? true : false>,
];

const dir = join(dirname(fileURLToPath(import.meta.url)), "agui");
const T = "turn-1";

async function* from(events: AgentEvent[], failure?: Error): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
  if (failure) throw failure;
}

async function run(events: AgentEvent[], failure?: Error): Promise<string> {
  let now = 1_700_000_000_000;
  const out: AgUiEvent[] = [];
  for await (const e of agUiEvents(from(events, failure), { threadId: "thread-1", clock: () => now++ })) out.push(e);
  // Every event must be a valid event of @ag-ui/core 1.0.4.
  for (const e of out) EventSchemas.parse(e);
  return out.map((e) => agUiJson(e) + "\n").join("");
}

function golden(name: string, actual: string): void {
  const path = join(dir, `${name}.jsonl`);
  if (process.env.FADEN_UPDATE_GOLDEN === "1") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, actual, { encoding: "utf8" });
  }
  expect(existsSync(path)).toBe(true);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

const started: AgentEvent = { type: "turn_started", turnId: T, toolMode: "ask" };
const done = (outcome: "completed" | "response_blocked", text: string, usage = true): AgentEvent => ({
  type: "turn_completed",
  turnId: T,
  result: {
    turnId: T,
    outcome,
    text,
    notices: [],
    usage: usage ? { promptTokens: 12, completionTokens: 5, totalTokens: 17 } : undefined,
    receipts: [],
  },
});

const request: ApprovalRequest = {
  sessionId: "thread-1",
  turnId: T,
  callId: "call-2",
  toolName: "delete_page",
  toolClass: "destructive",
  source: "host",
  reason: "Deleting cannot be undone.",
  arguments: { page: 8 },
};

describe("AG-UI events", () => {
  it("text, with reasoning before it", async () => {
    golden("text", await run([
      started,
      { type: "reasoning", turnId: T, text: "Greeting " },
      { type: "reasoning", turnId: T, text: "the user." },
      { type: "text", turnId: T, text: "Hello <b>wor" },
      { type: "text", turnId: T, text: "ld</b> & \"all\" - caf\u00e9\nBye" },
      done("completed", "Hello <b>world</b> & \"all\" - caf\u00e9\nBye"),
    ]));
  });

  it("a tool call and its result", async () => {
    golden("tool", await run([
      started,
      { type: "text", turnId: T, text: "Let me look." },
      { type: "tool_started", turnId: T, callId: "call-1", name: "read_page", toolClass: "read", source: "host", arguments: { page: 7, note: "a<b" } },
      { type: "tool_completed", turnId: T, callId: "call-1", name: "read_page", source: "host", outcome: "ok", result: "Table T1, 4 rows", durationMs: 12 },
      { type: "text", turnId: T, text: "Four rows." },
      done("completed", "Let me look.Four rows."),
    ]));
  });

  it("an approval ends the run with an interrupt, and the answer resumes on a new run", async () => {
    golden("approval", await run([
      started,
      { type: "tool_started", turnId: T, callId: "call-2", name: "delete_page", toolClass: "destructive", source: "host", arguments: { page: 8 } },
      { type: "approval_requested", turnId: T, request },
      { type: "approval_decided", turnId: T, request, decision: { approved: true } },
      { type: "tool_completed", turnId: T, callId: "call-2", name: "delete_page", source: "host", outcome: "ok", result: "deleted", durationMs: 3 },
      { type: "text", turnId: T, text: "Deleted." },
      done("completed", "Deleted."),
    ]));
  });

  it("an error of the stream ends the run with RUN_ERROR", async () => {
    golden("error", await run([started, { type: "text", turnId: T, text: "Partial" }], new Error("The model call failed.")));
  });

  it("notices and gateway words become faden.* custom events; the gateway round stays out", async () => {
    golden("notice", await run([
      started,
      { type: "gateway_event", turnId: T, event: { type: "CUSTOM", name: "faden.citations", value: { tool: "knowledge_search", sources: [{ source: "a.pdf", score: 0.9 }] }, raw: {} } },
      { type: "gateway_event", turnId: T, event: { type: "CUSTOM", name: "faden.gateway_round", value: { messages: [] }, raw: {} } },
      { type: "gateway_event", turnId: T, event: { type: "TOOL_CALL_START", raw: {} } },
      { type: "notice", turnId: T, notice: { outcome: "response_blocked", stage: "output", category: "pii", message: "Answer withheld.", requestId: "req-1" } },
      done("response_blocked", "", false),
    ]));
  });

  it("an abort is thrown on, not turned into RUN_ERROR", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(run([started], abort)).rejects.toThrow("aborted");
  });
});
