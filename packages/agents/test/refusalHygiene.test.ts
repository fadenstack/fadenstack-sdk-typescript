import { describe, expect, it } from "vitest";
import { ApprovalDecision, EntryTypes, type AgentSession } from "@fadenstack/agents";
import { lastToolResults, type FakeModel, type FakeReply } from "@fadenstack/testing";
import { setup } from "./helpers.js";

// What the gateway's words do on the device (.NET GovernanceHygieneTests): a refusal is never lost to a missing call id,
// only a refusal refuses, the gateway's tool mode only narrows.

const custom = (name: string, value: Record<string, unknown>) => ({ type: "CUSTOM", name, value });

/** Round one carries `first`, the next rounds answer. */
const twoRounds = (first: FakeReply): FakeModel => (request) => lastToolResults(request).size ? { text: "OK." } : first;

const completed = (session: AgentSession) =>
  session.transcript.filter(e => e.type === EntryTypes.toolComplete && e.data["source"] !== "gateway")
    .map(e => ({ id: e.data["call_id"] as string, outcome: e.data["outcome"] as string }));

const sentResultIds = (s: { gateway: { modelCalls: { messages: { role: string; tool_call_id?: string }[] }[] } }) =>
  s.gateway.modelCalls[1]!.messages.filter(m => m.role === "tool").map(m => m.tool_call_id);

const read = (page: number) => ({ name: "read_page", id: "", arguments: { page } });

describe("a gateway refusal is never lost", () => {
  it("without a call id it denies every call of that tool, and the calls get ids of their own", async () => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.tool_denied", { toolCallId: "", toolCallName: "read_page", message: "Not here." })],
      toolCalls: [read(7), read(8), { name: "write_page", id: "", arguments: { page: 8, text: "x" } }],
    }) }, () => ApprovalDecision.approve());
    try {
      const session = await s.agent.startSession();
      const result = await session.send("Go.");
      const ids = [0, 1, 2].map(i => `fs-${result.turnId}-0-${i}`);
      expect(completed(session)).toEqual([
        { id: ids[0], outcome: "denied" }, { id: ids[1], outcome: "denied" }, { id: ids[2], outcome: "ok" }]);
      expect(result.outcome).toBe("tool_denied");
      expect(s.pages.pages.get(8)).toBe("x");
      const asked = session.transcript.find(e => e.type === EntryTypes.assistantMessage)!;
      expect((asked.data["tool_calls"] as { id: string }[]).map(c => c.id)).toEqual(ids);
      expect(sentResultIds(s)).toEqual(ids);
    } finally { await s.agent.dispose(); }
  });

  it("names a call by its index when the gateway says so", async () => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.tool_denied", { toolCallId: "", toolCallName: "read_page", toolCallIndex: 1, message: "Not this one." })],
      toolCalls: [read(7), read(8)],
    }) });
    try {
      const session = await s.agent.startSession();
      await session.send("Go.");
      expect(completed(session).map(c => c.outcome)).toEqual(["ok", "denied"]);
    } finally { await s.agent.dispose(); }
  });

  it("denies every call of the tool when an id is shared, and leaves other tools alone", async () => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.tool_denied", { toolCallId: "dup", toolCallName: "read_page", message: "Not here." })],
      toolCalls: [{ ...read(7), id: "dup" }, { ...read(8), id: "dup" }, { name: "write_page", id: "unique", arguments: { page: 3, text: "x" } }],
    }) }, () => ApprovalDecision.approve());
    try {
      const session = await s.agent.startSession();
      const result = await session.send("Go.");
      expect(sentResultIds(s)).toEqual([`fs-${result.turnId}-0-0`, `fs-${result.turnId}-0-1`, "unique"]);
      expect(completed(session).map(c => c.outcome)).toEqual(["denied", "denied", "ok"]);
    } finally { await s.agent.dispose(); }
  });

  it("keeps unique ids and hits only the call it names", async () => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.tool_denied", { toolCallId: "call-2", toolCallName: "read_page", message: "Not that one." })],
      toolCalls: [{ ...read(7), id: "call-1" }, { ...read(8), id: "call-2" }],
    }) });
    try {
      const session = await s.agent.startSession();
      await session.send("Go.");
      expect(completed(session)).toEqual([{ id: "call-1", outcome: "ok" }, { id: "call-2", outcome: "denied" }]);
    } finally { await s.agent.dispose(); }
  });

  it("a mark without a call id asks for every call of that tool as a rule", async () => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.approval_required", { toolCallId: "", toolCallName: "read_page", message: "Ask first." })],
      toolCalls: [read(7), read(8)],
    }) }, () => ApprovalDecision.approve());
    try {
      const session = await s.agent.startSession();
      const result = await session.send("Go.");
      expect(s.asked.map(r => r.callId)).toEqual([`fs-${result.turnId}-0-0`, `fs-${result.turnId}-0-1`]);
      expect(s.asked.every(r => r.requiredByRule === true && r.reason === "Ask first.")).toBe(true);
    } finally { await s.agent.dispose(); }
  });

  it("several marks on one call merge: the rule wins and the stricter class", async () => {
    const s = await setup({ model: twoRounds({
      events: [
        custom("faden.approval_required", { toolCallId: "c1", toolCallName: "read_page", toolClass: "write", rule: false, message: "Mode." }),
        custom("faden.approval_required", { toolCallId: "c1", toolCallName: "read_page", toolClass: "destructive", rule: true, message: "Rule." }),
      ],
      toolCalls: [{ ...read(7), id: "c1" }],
    }) }, () => ApprovalDecision.approve());
    try {
      await (await s.agent.startSession()).send("Go.");
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]).toMatchObject({ toolClass: "destructive", requiredByRule: true, reason: "Rule." });
    } finally { await s.agent.dispose(); }
  });
});

describe("only a refusal refuses", () => {
  it("a governance outcome nobody knows informs and the turn goes on", async () => {
    const s = await setup({ model: () => ({
      events: [custom("faden.governance", { outcome: "observe", stage: "input", message: "Noted." })], text: "Fine.",
    }) });
    try {
      const session = await s.agent.startSession();
      const first = await session.send("Hello.");
      expect([first.outcome, first.text, first.notices.map(n => n.outcome)]).toEqual(["completed", "Fine.", ["observe"]]);
      expect(session.transcript.find(e => e.type === EntryTypes.turnEnd)!.status).toBe("ok");
      await session.send("And now?");
      expect(s.gateway.modelCalls[1]!.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    } finally { await s.agent.dispose(); }
  });

  it("a response_blocked event still refuses", async () => {
    const s = await setup({ model: () => ({ text: "Secret.", refuse: { stage: "output", message: "No." } }) });
    try {
      const result = await (await s.agent.startSession()).send("Hello.");
      expect(result.outcome).toBe("response_blocked");
    } finally { await s.agent.dispose(); }
  });
});

describe("the gateway's tool mode only narrows", () => {
  const withMode = async (tool: "read_page" | "write_page", start: "ask" | "auto", mode: Record<string, unknown>) => {
    const s = await setup({ model: twoRounds({
      events: [custom("faden.tool_mode", mode)],
      toolCalls: [{ name: tool, id: "call-1", arguments: tool === "read_page" ? { page: 7 } : { page: 8, text: "x" } }],
    }) }, () => ApprovalDecision.approve());
    const session = await s.agent.startSession(start);
    await session.send("Go.");
    await s.agent.dispose();
    return { s, session };
  };

  it("narrows the turn", async () => {
    const { s, session } = await withMode("write_page", "auto",
      { tool_mode: "auto", effective_tool_mode: "read_only", tool_mode_ceiling: "read_only", hidden: [] });
    expect(s.pages.pages.get(8)).toBe("Figure F2");
    expect(s.asked).toEqual([]);
    expect(completed(session).map(c => c.outcome)).toEqual(["denied"]);
  });

  it.each(["auto", "bogus"])("never widens the turn (%s)", async (effective) => {
    const { s } = await withMode("write_page", "ask", { tool_mode: "auto", effective_tool_mode: effective, hidden: [] });
    expect(s.asked).toHaveLength(1); // still ask: a write tool is asked about
    expect(s.pages.pages.get(8)).toBe("x");
  });

  it("refuses a tool the gateway hides, here too", async () => {
    const { s, session } = await withMode("read_page", "ask", { tool_mode: "ask", effective_tool_mode: "ask", hidden: ["read_page"] });
    expect(s.asked).toEqual([]);
    expect(completed(session).map(c => c.outcome)).toEqual(["denied"]);
    expect(session.transcript.some(e => e.type === EntryTypes.governanceNotice && e.data["outcome"] === "tool_denied")).toBe(true);
  });
});
