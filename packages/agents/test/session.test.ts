import { describe, expect, it } from "vitest";

import { FadenstackError } from "@fadenstack/client";
import { ApprovalDecision, EntryTypes, TurnStatus } from "@fadenstack/agents";
import { lastToolResults, lastUserText, type FakeModel } from "@fadenstack/testing";

import { collect, setup, types, until } from "./helpers.js";

/** A model that calls `tool` with `args` once, then answers with what the tool said. */
function callsOnce(tool: string, args: Record<string, unknown>): FakeModel {
  return (request) => {
    const results = lastToolResults(request);
    if (results.size === 0) return { text: "Let me check.", toolCalls: [{ name: tool, arguments: args }] };
    return { text: `The tool said: ${[...results.values()].join(" | ")}` };
  };
}

describe("a turn", () => {
  it("runs a read tool without asking, and answers with its result", async () => {
    const s = await setup({ model: callsOnce("read_page", { page: 7 }) });
    const session = await s.agent.startSession();
    const events = await collect(session.stream("What is on page 7?"));
    // Text streams in chunks: one run of text before the tool, one after.
    expect(types(events).filter((t, i, all) => t !== all[i - 1])).toEqual([
      "turn_started", "text", "tool_started", "tool_completed", "text", "turn_completed",
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "turn_completed", result: { outcome: "completed" } });
    expect((done as { result: { text: string } }).result.text).toContain("Table T1, 4 rows");
    expect(s.asked).toEqual([]);
    // The second model call saw the tool's answer, linked to its call.
    const second = s.gateway.modelCalls[1]!;
    expect(second.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "read_page" } }] });
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", content: "Table T1, 4 rows" });
    expect(second.toolMode).toBe("ask");
    expect(second.conversationId).toBe(session.id);
  });

  it("asks before a write tool in ask, and runs it once allowed", async () => {
    const s = await setup({ model: callsOnce("write_page", { page: 8, text: "Figure F3" }) });
    const session = await s.agent.startSession();
    const result = await session.send("Rename the terminal");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ toolName: "write_page", toolClass: "write", source: "host", arguments: { page: 8, text: "Figure F3" } });
    expect(s.pages.pages.get(8)).toBe("Figure F3");
    expect(result.outcome).toBe("completed");
    await s.agent.flush();
    expect(s.gateway.reported.map((e) => e["type"])).toEqual(["approval.decided", "tool.executed"]);
    expect(s.gateway.reported[0]).toMatchObject({ decision: "approved", tool: "write_page" });
  });

  it("tells the model when the user declined, and marks the turn tool_denied", async () => {
    const s = await setup({ model: callsOnce("delete_page", { page: 8 }) }, () => ApprovalDecision.deny("not today"));
    const session = await s.agent.startSession();
    const result = await session.send("Delete page 8");
    expect(s.pages.deleted).toEqual([]);
    expect(result.outcome).toBe("tool_denied");
    expect(lastToolResults(s.gateway.modelCalls[1]!).values().next().value).toBe("The user declined to run 'delete_page' (not today).");
  });

  it("stops asking for a tool approved for the chat, until the chat is opened again", async () => {
    const s = await setup({ model: callsOnce("write_page", { page: 8, text: "x" }) }, () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("one");
    await session.send("two");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ canAllowForSession: true, canAllowAlways: true });
    const decisions = session.transcript.filter((e) => e.type === EntryTypes.approvalDecision).map((e) => e.data);
    expect(decisions).toMatchObject([
      { approved: true, scope: "chat", asked: true, for_session: true },
      { approved: true, scope: "chat", asked: false, for_session: false },
    ]);
    // Opened again (another window, the next day): it asks again.
    const reopened = await s.agent.openSession(session.id);
    expect(reopened.approvedForSession.size).toBe(0);
    await reopened.send("three");
    expect(s.asked).toHaveLength(2);
  });

  it("runs write tools in auto, still asks before destructive ones", async () => {
    const s = await setup({ model: callsOnce("write_page", { page: 8, text: "y" }) });
    const session = await s.agent.startSession("auto");
    await session.send("write");
    expect(s.asked).toHaveLength(0);
    s.gateway.setModel(callsOnce("delete_page", { page: 7 }));
    await session.send("delete");
    expect(s.asked.map((a) => a.toolName)).toEqual(["delete_page"]);
  });

  it("does not offer hidden tools, and refuses them if the model calls them anyway", async () => {
    const s = await setup({ model: callsOnce("write_page", { page: 8, text: "z" }) });
    const session = await s.agent.startSession("read_only");
    const events = await collect(session.stream("write"));
    expect(s.gateway.modelCalls[0]!.tools.map((t) => t.name)).toEqual(["read_page"]);
    // The gateway refuses the call as it hands it over; the session would refuse it on its own too.
    expect(events.find((e) => e.type === "notice")).toMatchObject({ notice: { outcome: "tool_denied" } });
    expect(events.find((e) => e.type === "tool_completed")).toMatchObject({ outcome: "denied" });
    expect(s.pages.pages.get(8)).toBe("Figure F2");
  });

  it("checks the arguments before asking", async () => {
    const s = await setup({ model: callsOnce("write_page", { page: "eight" }) });
    const session = await s.agent.startSession();
    await session.send("write");
    expect(s.asked).toHaveLength(0);
    expect(lastToolResults(s.gateway.modelCalls[1]!).values().next().value)
      .toBe("Error: Invalid arguments: 'text' is required; 'page' must be integer.");
  });

  it("offers only the tools in the agent's contract, under the stricter class", async () => {
    const s = await setup({
      agents: [{ slug: "docs", contract: [{ name: "read_page", risk: "write" }, { name: "write_page", risk: "write" }] }],
      model: callsOnce("read_page", { page: 7 }),
    });
    await s.agent.start();
    expect(s.agent.tools.map((t) => [t.name, t.toolClass])).toEqual([["read_page", "write"], ["write_page", "write"]]);
    const session = await s.agent.startSession();
    await session.send("read");
    expect(s.asked.map((a) => a.toolName)).toEqual(["read_page"]); // write now: it asks in ask
  });

  it("tells the server what the app brings, also the tools its contract does not list yet", async () => {
    const s = await setup(
      { agents: [{ slug: "docs", contract: [{ name: "read_page", risk: "read" }] }], model: () => ({ text: "ok" }) },
      undefined,
      (b) => b.describeApp({
        name: "Viewer add-in",
        version: "2.1.0",
        context: [{ id: "project:pages", title: "The project's pages" }],
        ui: { greeting: "Ask about your project." },
      }),
    );
    await s.agent.start();
    expect(s.agent.tools.map((t) => t.name)).toEqual(["read_page"]); // the others wait for the server's review
    await until(() => s.gateway.manifests.length > 0);
    const { agent, manifest } = s.gateway.manifests[0]!;
    expect(agent).toBe("docs");
    expect(manifest).toMatchObject({
      app: { name: "Viewer add-in", version: "2.1.0" },
      sdk: { language: "typescript" },
      context: [{ id: "project:pages", title: "The project's pages" }],
      ui: { greeting: "Ask about your project." },
    });
    expect((manifest["tools"] as { name: string; class: string }[]).map((t) => [t.name, t.class])).toEqual([
      ["read_page", "read"], ["write_page", "write"], ["delete_page", "destructive"],
    ]);
    expect((manifest["tools"] as Record<string, unknown>[])[0]).toMatchObject({
      description: "Reads a page.", parameters: { type: "object", required: ["page"] },
    });
  });

  it("does not report the app when event reporting is off", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) }, undefined, (b) => b.useEventReporting(false));
    await s.agent.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.gateway.manifests).toEqual([]);
  });

  it("narrows the session's mode to the agent's ceiling", async () => {
    const s = await setup({ agents: [{ slug: "docs", ceiling: "read_only" }], model: () => ({ text: "ok" }) });
    const session = await s.agent.startSession("auto");
    expect(session.effectiveToolMode).toBe("read_only");
    await session.send("hi");
    expect(s.gateway.modelCalls[0]!.toolMode).toBe("read_only");
  });

  it("stops after the round limit", async () => {
    const s = await setup({ model: () => ({ toolCalls: [{ name: "read_page", arguments: { page: 7 } }] }) }, undefined, (b) => b.useMaxRounds(3));
    const session = await s.agent.startSession();
    const result = await session.send("loop");
    expect(s.gateway.modelCalls).toHaveLength(3);
    expect(result.notices[0]).toMatchObject({ outcome: "round_limit" });
  });
});

describe("refusals are outcomes", () => {
  it("a refused prompt is not sent again", async () => {
    const s = await setup({ model: (r) => (lastUserText(r).includes("secret") ? { refuse: { stage: "input", message: "No secrets." } } : { text: "fine" }) });
    const session = await s.agent.startSession();
    const refused = await session.send("the secret plan");
    expect(refused).toMatchObject({ outcome: "prompt_blocked", notices: [{ outcome: "prompt_blocked", message: "No secrets." }] });
    await session.send("something else");
    expect(s.gateway.modelCalls[1]!.messages).toEqual([{ role: "user", content: "something else" }]);
  });

  it("a stopped answer keeps only its question, and its tool calls never run", async () => {
    const s = await setup({ model: () => ({ text: "Here", toolCalls: [{ name: "delete_page", arguments: { page: 7 } }], refuse: { stage: "output", message: "Stopped." } }) });
    const session = await s.agent.startSession("auto");
    const result = await session.send("q1");
    expect(result.outcome).toBe("response_blocked");
    expect(s.pages.deleted).toEqual([]);
    expect(s.asked).toEqual([]);
    s.gateway.setModel(() => ({ text: "ok" }));
    await session.send("q2");
    // Consecutive user messages are one message: strict chat templates refuse two in a row.
    expect(s.gateway.modelCalls[1]!.messages).toEqual([{ role: "user", content: "q1\n\nq2" }]);
  });

  it("a rate limit ends the turn with its notice and wait", async () => {
    const s = await setup({ model: () => ({ rateLimit: { retryAfterS: 30 } }) });
    const session = await s.agent.startSession();
    const result = await session.send("hi");
    expect(result).toMatchObject({ outcome: "rate_limited", notices: [{ outcome: "rate_limited", retryAfterMs: 30_000 }] });
  });

  it("a client tool the gateway refused is not run", async () => {
    const s = await setup({
      model: (r) => (lastToolResults(r).size ? { text: "ok" }
        : { deniedTool: { name: "write_page", message: "Writing is blocked by a rule.", callId: "call_x" },
            toolCalls: [{ id: "call_x", name: "write_page", arguments: { page: 8, text: "q" } }] }),
    });
    const session = await s.agent.startSession("auto");
    const result = await session.send("write");
    expect(result.outcome).toBe("tool_denied");
    expect(result.notices[0]).toMatchObject({ message: "Writing is blocked by a rule." });
    expect(s.pages.pages.get(8)).toBe("Figure F2");
  });
});

describe("the gateway's own tools", () => {
  it("keeps the gateway's round in the transcript and sends it back", async () => {
    const s = await setup({ model: () => ({ gatewayTool: { name: "knowledge_search", arguments: { q: "sales" }, result: "T1 has 4 rows" }, text: "M1 runs at 400 V." }) });
    const session = await s.agent.startSession();
    const events = await collect(session.stream("Voltage of M1?"));
    expect(events.filter((e) => e.type === "tool_started" || e.type === "tool_completed").map((e) => [e.type, (e as { source: string }).source]))
      .toEqual([["tool_started", "gateway"], ["tool_completed", "gateway"]]);
    await session.send("And M2?");
    const history = s.gateway.modelCalls[1]!.messages;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(history[2]).toMatchObject({ role: "tool", content: "T1 has 4 rows" });
  });

  it("answers the gateway's approval with the user's decision", async () => {
    const s = await setup(
      { model: () => ({ gatewayTool: { name: "mcp_github.delete_repo", approval: { message: "Deleting needs your OK." } }, text: "Done." }) },
      () => ApprovalDecision.approve(),
    );
    const session = await s.agent.startSession();
    await session.send("delete the repo");
    expect(s.asked[0]).toMatchObject({ toolName: "mcp_github.delete_repo", source: "gateway", reason: "Deleting needs your OK." });
    expect(s.gateway.approvals).toEqual([{ approvalId: expect.stringMatching(/^approval-/), approved: true }]);
  });
});

describe("stopping", () => {
  it("a stopped turn is recorded as cancelled and left out of the next request", async () => {
    const s = await setup({ model: () => ({ text: "a long answer that streams slowly", delayMs: 20 }) });
    const session = await s.agent.startSession();
    const controller = new AbortController();
    const events: string[] = [];
    await expect((async () => {
      for await (const e of session.stream("first", { signal: controller.signal })) {
        events.push(e.type);
        if (e.type === "text") controller.abort(new Error("stopped by the user"));
      }
    })()).rejects.toThrow("stopped by the user");
    expect(session.transcript.at(-1)).toMatchObject({ type: EntryTypes.turnEnd, status: TurnStatus.cancelled });
    expect(session.isRunning).toBe(false);
    s.gateway.setModel(() => ({ text: "ok" }));
    await session.send("second");
    expect(s.gateway.modelCalls.at(-1)!.messages).toEqual([{ role: "user", content: "second" }]);
  });

  it("leaving the stream early stops the turn", async () => {
    const s = await setup({ model: () => ({ text: "abcdefghijklmnopqrstuvwxyz", delayMs: 10 }) });
    const session = await s.agent.startSession();
    for await (const e of session.stream("go")) if (e.type === "text") break;
    expect(session.transcript.at(-1)).toMatchObject({ status: TurnStatus.cancelled });
  });

  it("one turn at a time", async () => {
    const s = await setup({ model: () => ({ text: "slow", delayMs: 20 }) });
    const session = await s.agent.startSession();
    const first = session.send("one");
    await expect(session.send("two")).rejects.toThrow("already running");
    await first;
  });
});

describe("the agent", () => {
  it("refuses to start without a module the agent requires", async () => {
    const s = await setup({ agents: [{ slug: "docs", requiredClientModules: ["pii.local"] }] });
    await expect(s.agent.start()).rejects.toBeInstanceOf(FadenstackError);
  });

  it("lists sessions by their first message, newest first, and deletes them", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) });
    const a = await s.agent.startSession();
    await a.send("First question");
    await new Promise((r) => setTimeout(r, 5));
    const b = await s.agent.startSession();
    await b.send("Second question");
    expect((await s.agent.listSessions()).map((x) => x.title)).toEqual(["Second question", "First question"]);
    await s.agent.deleteSession(a.id);
    expect((await s.agent.listSessions()).map((x) => x.id)).toEqual([b.id]);
  });

  it("goes on with a reopened session in its last mode", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) });
    const session = await s.agent.startSession("read_only");
    await session.send("hi");
    const reopened = await s.agent.openSession(session.id);
    expect(reopened.toolMode).toBe("read_only");
    await reopened.send("again");
    expect(s.gateway.modelCalls.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("sends attachments before the question, and keeps them for later turns", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) });
    const session = await s.agent.startSession();
    await session.send("Summarise this", { attachments: [{ title: "Selection", content: "Sales list", kind: "selection", source: "page", reference: "page:selection" }] });
    await session.send("Shorter");
    const first = s.gateway.modelCalls[1]!.messages[0]!;
    expect(first.content).toBe('<attachment title="Selection" kind="selection" source="page" reference="page:selection">\nSales list\n</attachment>\n\nSummarise this');
  });
});
