import { describe, expect, it } from "vitest";

import { MemoryClipboard, MarkdownPart, ReasoningPart, ToolCallPart, TurnViewModel, builtInStrings, type PartContext } from "@fadenstack/ui";

// "Thought for N s" counts the thinking only: not a tool's run, an approval's wait or the answer's streaming (.NET ReasoningTimeTests).

function turn() {
  let now = 1_000_000;
  const context: PartContext = { strings: builtInStrings["en"]!, clipboard: new MemoryClipboard(), locale: "en", previewLength: 100, now: () => new Date(now) };
  const view = new TurnViewModel(context, undefined, "q", new Date(now));
  return { view, wait: (seconds: number) => { now += seconds * 1000; } };
}
const delegate = { type: "tool_started", turnId: "t", callId: "call-1", name: "delegate", toolClass: "write", source: "host", arguments: { agent: "word-assistant" } } as const;

describe("Thought for N s", () => {
  it("thinking after a tool call is its own block below it, and the first keeps its time", () => {
    // Found live: a turn that thought 30 s, delegated for 100 s and thought again read "Thought for 139 s".
    const { view, wait } = turn();
    view.appendReasoning("Word work goes to the Word assistant.");
    wait(4);
    view.toolStarted(delegate);
    wait(100); // the delegate runs
    view.appendReasoning("It is done; say so.");
    wait(3);
    view.fail("stopped here");

    expect(view.parts.map((p) => p.constructor)).toEqual([ReasoningPart, ToolCallPart, ReasoningPart]);
    const thoughts = view.parts.filter((p): p is ReasoningPart => p instanceof ReasoningPart);
    expect(thoughts.map((t) => t.title)).toEqual(["Thought for 4 s", "Thought for 3 s"]);
    expect(thoughts.every((t) => !t.isStreaming)).toBe(true);
  });

  it("the answer starting ends the thinking", () => {
    const { view, wait } = turn();
    view.appendReasoning("A short answer will do.");
    wait(2);
    view.appendText("Hello");
    wait(60); // the answer streams
    const thought = view.parts.find((p): p is ReasoningPart => p instanceof ReasoningPart)!;
    expect(thought.isStreaming).toBe(false);
    expect(thought.title).toBe("Thought for 2 s");
    view.fail("stopped here");
    expect(thought.title).toBe("Thought for 2 s");
    expect(view.parts.map((p) => p.constructor)).toEqual([ReasoningPart, MarkdownPart]);
  });

  it("thinking after the answer began is a block of its own", () => {
    const { view, wait } = turn();
    view.appendReasoning("first");
    wait(1);
    view.appendText("Answer. ");
    wait(30);
    view.appendReasoning("second thoughts");
    wait(5);
    view.fail("end");
    const thoughts = view.parts.filter((p): p is ReasoningPart => p instanceof ReasoningPart);
    expect(thoughts.map((t) => t.title)).toEqual(["Thought for 1 s", "Thought for 5 s"]);
  });
});
