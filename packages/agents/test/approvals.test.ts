import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalDecision, EntryTypes, MemoryApprovalStore, type AgentSession } from "@fadenstack/agents";
import { lastToolResults, type FakeModel, type FakeReply } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup } from "./helpers.js";

/** A model that makes `call` once, then answers with what the tool said. */
function once(call: { name: string; arguments: Record<string, unknown>; id?: string }, extra: Partial<FakeReply> = {}): FakeModel {
  return (request) => (lastToolResults(request).size
    ? { text: `Done: ${[...lastToolResults(request).values()].join(" | ")}` }
    : { text: "On it.", toolCalls: [call], ...extra });
}

const decisions = (session: AgentSession) =>
  session.transcript.filter((e) => e.type === EntryTypes.approvalDecision).map((e) => e.data);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Allow for this chat and Allow always", () => {
  it("are offered for a classified tool that changes something, and Allow always holds in the next chat", async () => {
    const approvals = new MemoryApprovalStore();
    const s = await setup({ model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) },
      () => ApprovalDecision.approveAlways(), (b) => b.useApprovalStore(approvals));
    const first = await s.agent.startSession();
    await first.send("write");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ toolClass: "write", canAllowForSession: true, canAllowAlways: true });
    expect(await approvals.list("docs")).toMatchObject([{ tool: "write_page", toolClass: "write" }]);
    const second = await s.agent.startSession();
    await second.send("write again");
    expect(s.asked).toHaveLength(1);
    expect(decisions(second)).toMatchObject([{ approved: true, scope: "always", asked: false }]);
    await s.agent.flush();
    expect(s.gateway.reported.filter((e) => e["type"] === "approval.decided").map((e) => e["scope"])).toEqual(["always", "always"]);
  });

  it("are never offered for a destructive tool, and a handler that answers with them allows that call only", async () => {
    const approvals = new MemoryApprovalStore();
    let answer = ApprovalDecision.approveForSession();
    const s = await setup({ model: once({ name: "delete_page", arguments: { page: 7 } }) }, () => answer,
      (b) => b.useApprovalStore(approvals));
    const session = await s.agent.startSession();
    await session.send("delete");
    answer = ApprovalDecision.approveAlways();
    await session.send("delete again");
    expect(s.asked).toHaveLength(2);
    expect(s.asked[0]).toMatchObject({ toolClass: "destructive", canAllowForSession: false, canAllowAlways: false });
    expect(decisions(session).map((d) => d["scope"])).toEqual(["once", "once"]);
    expect(session.approvedForSession.size).toBe(0);
    expect(await approvals.list("docs")).toEqual([]);
  });

  it("an approval kept always no longer holds once the tool became destructive", async () => {
    const approvals = new MemoryApprovalStore();
    await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await setup({
      agents: [{ slug: "docs", contract: [{ name: "write_page", risk: "destructive" }] }],
      model: once({ name: "write_page", arguments: { page: 8, text: "x" } }),
    }, () => ApprovalDecision.approve(), (b) => b.useApprovalStore(approvals));
    const session = await s.agent.startSession();
    await session.send("write");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ toolClass: "destructive", canAllowAlways: false });
  });

  it("are forgotten by a reset: one tool, or all of them", async () => {
    const approvals = new MemoryApprovalStore();
    const s = await setup({ model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) },
      () => ApprovalDecision.approveAlways(), (b) => b.useApprovalStore(approvals));
    await approvals.add("docs", { tool: "other_tool", toolClass: "write", approvedAt: new Date().toISOString() });
    const session = await s.agent.startSession();
    await session.send("write");
    await s.agent.resetApprovals("write_page");
    expect((await approvals.list("docs")).map((a) => a.tool)).toEqual(["other_tool"]);
    await session.send("write again");
    expect(s.asked).toHaveLength(2);
    await s.agent.resetApprovals();
    expect(await approvals.list("docs")).toEqual([]);
  });

  it("a chat's approval ends with a reset of the chat", async () => {
    const s = await setup({ model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) },
      () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("one");
    session.resetApprovals();
    await session.send("two");
    expect(s.asked).toHaveLength(2);
  });
});

describe("without a tool contract", () => {
  it("every tool is unclassified: a tool its app calls read asks, every time", async () => {
    const s = await setup({ agents: [{ slug: "docs" }], model: once({ name: "read_page", arguments: { page: 7 } }) },
      () => ApprovalDecision.approveForSession());
    await s.agent.start();
    expect(s.agent.tools.map((t) => t.toolClass)).toEqual(["unknown", "unknown", "unknown"]);
    const session = await s.agent.startSession();
    await session.send("read");
    await session.send("read again");
    expect(s.asked).toHaveLength(2);
    expect(s.asked[0]).toMatchObject({ toolClass: "unknown", canAllowForSession: false, reason: "Nobody has said what this tool does." });
  });

  it("a contract entry without a risk leaves that tool unclassified", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [{ name: "read_page" }, { name: "write_page", risk: "write" }] }] });
    await s.agent.start();
    expect(s.agent.tools.map((t) => [t.name, t.toolClass])).toEqual([["read_page", "unknown"], ["write_page", "write"]]);
  });
});

describe("an admin's Ask first rule", () => {
  const rules = [{ pattern: "read_*", action: "approval_required" as const, message: "Reading pages needs your OK." }];

  it("asks before the agent's own tool, a read one too, with the admin's message, Allow once only", async () => {
    const s = await setup({ toolRules: rules, model: once({ name: "read_page", arguments: { page: 7 } }) },
      () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("read");
    await session.send("read again");
    expect(s.asked).toHaveLength(2);
    expect(s.asked[0]).toMatchObject({
      toolName: "read_page", reason: "Reading pages needs your OK.", requiredByRule: true, canAllowForSession: false, canAllowAlways: false,
    });
    expect(decisions(session)).toMatchObject([{ approved: true, scope: "once", rule: true, asked: true }, { scope: "once" }]);
  });

  it("asks also in bypass mode, and over an approval kept always", async () => {
    const approvals = new MemoryApprovalStore();
    await approvals.add("docs", { tool: "read_page", toolClass: "read", approvedAt: new Date().toISOString() });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ toolRules: rules, model: once({ name: "read_page", arguments: { page: 7 } }) },
      () => ApprovalDecision.deny("no"), (b) => b.usePermissionMode("bypass").useApprovalStore(approvals));
    const session = await s.agent.startSession();
    const result = await session.send("read");
    expect(s.asked).toHaveLength(1);
    expect(result.outcome).toBe("tool_denied");
  });

  it("a tool a deny rule covers is not offered, and a call of it is refused by its id", async () => {
    const s = await setup({
      toolRules: [{ pattern: "write_page", action: "deny", message: "Writing is off." }],
      model: once({ name: "write_page", arguments: { page: 8, text: "x" }, id: "call_w" }),
    });
    const session = await s.agent.startSession("auto");
    const result = await session.send("write");
    expect(s.gateway.modelCalls[0]!.tools.map((t) => t.name)).not.toContain("write_page");
    expect(s.pages.pages.get(8)).toBe("Figure F2");
    expect(result.outcome).toBe("tool_denied");
  });

  it("is told in a mark the session takes no looser than its own class", async () => {
    // The gateway holds read_page as destructive (an admin's classification): it asks, once only.
    const mark = { type: "CUSTOM", name: "faden.approval_required", value: {
      toolCallId: "call_r", toolCallName: "read_page", message: "x", toolClass: "destructive", rule: false,
    } };
    const s = await setup({ model: once({ name: "read_page", arguments: { page: 7 }, id: "call_r" }, { events: [mark] }) });
    const session = await s.agent.startSession();
    await session.send("read");
    expect(s.asked).toMatchObject([{ toolName: "read_page", toolClass: "destructive", canAllowForSession: false }]);
    expect(s.asked[0]!.requiredByRule).toBeUndefined();
  });
});

describe("bypass mode", () => {
  it("approves what would ask, destructive too, says bypass in the transcript and the report, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ model: once({ name: "delete_page", arguments: { page: 7 } }) }, () => ApprovalDecision.deny(),
      (b) => b.usePermissionMode("bypass"));
    expect(s.agent.permissionMode).toBe("bypass");
    const session = await s.agent.startSession();
    await session.send("delete");
    await s.agent.restart();
    expect(s.asked).toEqual([]);
    expect(s.pages.deleted).toEqual([7]);
    expect(decisions(session)).toMatchObject([{ approved: true, scope: "bypass", asked: false, rule: false }]);
    await s.agent.flush();
    expect(s.gateway.reported.find((e) => e["type"] === "approval.decided")).toMatchObject({ decision: "approved", scope: "bypass" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("bypass mode");
  });

  it("does not widen the tool mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) }, undefined,
      (b) => b.usePermissionMode("bypass"));
    const session = await s.agent.startSession("read_only");
    const result = await session.send("write");
    expect(result.outcome).toBe("tool_denied");
    expect(s.pages.pages.get(8)).toBe("Figure F2");
  });
});

describe("the order", () => {
  it("destructive beats always, always beats this chat, this chat beats asking", async () => {
    const approvals = new MemoryApprovalStore();
    // Kept always for a destructive tool (an older store, or the app's own): it still asks.
    await approvals.add("docs", { tool: "delete_page", toolClass: "destructive", approvedAt: new Date().toISOString() });
    let answer = ApprovalDecision.approve();
    const s = await setup({ model: once({ name: "delete_page", arguments: { page: 7 } }) }, () => answer,
      (b) => b.useApprovalStore(approvals));
    const session = await s.agent.startSession();
    await session.send("delete");
    expect(s.asked).toHaveLength(1);

    s.gateway.setModel(once({ name: "write_page", arguments: { page: 8, text: "x" } }));
    answer = ApprovalDecision.approveForSession();
    await session.send("write"); // asked: allowed for this chat
    await session.send("write"); // this chat, not asked
    await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    await session.send("write"); // always, over this chat
    expect(s.asked).toHaveLength(2);
    expect(decisions(session).map((d) => [d["scope"], d["asked"]])).toEqual([
      ["once", true], ["chat", true], ["chat", false], ["always", false],
    ]);
  });
});

describe("the gateway's own tools", () => {
  it("offer this chat when the gateway says no rule asks and the tool only changes something", async () => {
    const s = await setup({ model: () => ({ gatewayTool: { name: "mcp_wiki.edit", approval: { message: "The tool mode is ask.", rule: false, toolClass: "write" } }, text: "Done." }) },
      () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("edit");
    await session.send("edit again");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ source: "gateway", toolClass: "write", canAllowForSession: true });
    expect(s.gateway.approvals.map((a) => a.approved)).toEqual([true, true]);
  });

  it("ask every time when the gateway does not say (an older gateway)", async () => {
    const s = await setup({ model: () => ({ gatewayTool: { name: "mcp_wiki.edit", approval: { message: "Needs your OK." } }, text: "Done." }) },
      () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("edit");
    await session.send("edit again");
    expect(s.asked).toHaveLength(2);
    expect(s.asked[0]).toMatchObject({ toolClass: "unknown", canAllowForSession: false, requiredByRule: true });
  });
});

describe("the page contract", () => {
  it("keeps the helper's classes", () => {
    expect(PAGE_CONTRACT.map((c) => c.risk)).toEqual(["read", "write", "destructive"]);
  });
});
