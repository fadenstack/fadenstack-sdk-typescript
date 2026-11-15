import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EventSchemas } from "@ag-ui/core/schemas";
import { agUiEvents, agUiJson, type AgentEvent, type AgUiEvent, type ApprovalRequest } from "@fadenstack/agents";

// AG-UI events (sdk/51 F07): the golden files in test/agui are the same bytes as the .NET SDK's
// tests/Fadenstack.Agents.Tests/AgUi, one JSON event per line. Set FADEN_UPDATE_GOLDEN=1 to write them.

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
