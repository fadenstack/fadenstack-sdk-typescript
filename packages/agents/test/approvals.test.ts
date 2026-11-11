import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalDecision, EntryTypes, MemoryApprovalStore, defineTool, type AgentSession } from "@fadenstack/agents";
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

// The app's Bypass is the server's, after a second sign-in; this SDK does not offer it yet, so bypass mode runs a
// session that would ask in auto instead, under the floor (fadenstack-dev sdk/43 §9 decision 2; as the .NET SDK).
describe("bypass mode", () => {
  it("never approves on its own: a destructive call still asks, nothing says bypass, and it warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ model: once({ name: "delete_page", arguments: { page: 7 } }) }, () => ApprovalDecision.deny(),
      (b) => b.usePermissionMode("bypass"));
    expect(s.agent.permissionMode).toBe("bypass");
    const session = await s.agent.startSession();
    const result = await session.send("delete");
    await s.agent.restart();
    expect(s.asked).toMatchObject([{ toolName: "delete_page", toolClass: "destructive", canAllowForSession: false }]);
    expect(s.pages.deleted).toEqual([]);
    expect(result.outcome).toBe("tool_denied");
    expect(decisions(session)).toMatchObject([{ approved: false, asked: true }]);
    await s.agent.flush();
    expect(s.gateway.reported.filter((e) => e["type"] === "approval.decided").map((e) => e["scope"])).not.toContain("bypass");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("bypass mode");
  });

  it("runs a session that would ask in auto: a write runs unasked, and the turn says auto", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) }, () => ApprovalDecision.deny(),
      (b) => b.usePermissionMode("bypass"));
    const session = await s.agent.startSession();
    expect(session.toolMode).toBe("ask");
    expect(session.effectiveToolMode).toBe("auto");
    await session.send("write");
    expect(s.asked).toEqual([]);
    expect(s.pages.pages.get(8)).toBe("x");
    expect(s.gateway.modelCalls[0]!.toolMode).toBe("auto");
  });

  it("stays under the app's own default and the server's ceiling", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const capped = await setup({}, undefined, (b) => b.usePermissionMode("bypass").useDefaultToolMode("ask"));
    expect((await capped.agent.startSession()).effectiveToolMode).toBe("ask");
    const ceiling = await setup({ agents: [{ slug: "docs", contract: PAGE_CONTRACT, ceiling: "ask" }] }, undefined,
      (b) => b.usePermissionMode("bypass"));
    expect((await ceiling.agent.startSession()).effectiveToolMode).toBe("ask");
  });

  it("never answers the gateway's own question: it goes to the person", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup(
      { model: () => ({ gatewayTool: { name: "mcp_github.delete_repo", approval: { message: "Deleting needs your OK.", rule: false } }, text: "Done." }) },
      () => ApprovalDecision.deny("not now"), (b) => b.usePermissionMode("bypass"));
    const session = await s.agent.startSession();
    await session.send("delete the repo");
    expect(s.asked).toMatchObject([{ toolName: "mcp_github.delete_repo", source: "gateway" }]);
    expect(s.gateway.approvals).toEqual([{ approvalId: expect.stringMatching(/^approval-/), approved: false }]);
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

// The agent's levels from a 0.7.0 server, as the .NET SDK reads them (fadenstack-dev sdk/43 §2: T2, T3).
describe("the agent's levels from the server", () => {
  const agent = (extra: Record<string, string>) => ({ agents: [{ slug: "docs", contract: PAGE_CONTRACT, ...extra }] });

  it("starts in the server's default level, also above ask, capped by the app's own default", async () => {
    expect((await (await setup(agent({ defaultLevel: "auto" }))).agent.startSession()).toolMode).toBe("auto");
    const capped = await setup(agent({ defaultLevel: "auto" }), undefined, (b) => b.useDefaultToolMode("ask"));
    expect((await capped.agent.startSession()).toolMode).toBe("ask");
    expect((await (await setup(agent({ defaultLevel: "bypass" }))).agent.startSession()).toolMode).toBe("ask");
    expect((await (await setup(agent({ defaultLevel: "later" }))).agent.startSession()).toolMode).toBe("ask");
  });

  it("never goes above the agent's highest level, and reads an unknown one as read only", async () => {
    const started = async (extra: Record<string, string>) => {
      const s = await setup(agent(extra));
      await s.agent.start();
      return s.agent;
    };
    expect((await started({ maxLevel: "ask" })).ceiling).toBe("ask");
    expect((await started({ maxLevel: "bypass" })).ceiling).toBe("auto");
    expect((await started({ ceiling: "auto", maxLevel: "later" })).ceiling).toBe("read_only");
    expect((await started({ defaultLevel: "auto", maxLevel: "read_only" })).defaultToolMode).toBe("read_only");
    const s = await setup({ ...agent({ maxLevel: "ask" }), model: once({ name: "write_page", arguments: { page: 8, text: "x" } }) },
      () => ApprovalDecision.deny());
    const session = await s.agent.startSession("auto");
    expect(session.effectiveToolMode).toBe("ask");
    await session.send("write");
    expect(s.asked).toHaveLength(1);
  });

  it("holds the gateway's word on a call for its round only", async () => {
    let round = 0;
    const mark = { type: "CUSTOM", name: "faden.approval_required",
      value: { toolCallId: "same", toolCallName: "write_page", message: "Checked by the gateway.", toolClass: "destructive", rule: false } };
    const s = await setup({ model: () => {
      round++;
      return round === 1 ? { text: "1", toolCalls: [{ name: "write_page", arguments: { page: 8, text: "a" }, id: "same" }], events: [mark] }
        : round === 2 ? { text: "2", toolCalls: [{ name: "write_page", arguments: { page: 8, text: "b" }, id: "same" }] }
        : { text: "Done." };
    } }, () => ApprovalDecision.approve());
    const session = await s.agent.startSession("auto");
    await session.send("write twice");
    expect(s.asked).toMatchObject([{ toolName: "write_page", toolClass: "destructive" }]); // the marked call only
    expect(s.pages.pages.get(8)).toBe("b");
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

describe("what a call acts on", () => {
  const CONTRACT = [...PAGE_CONTRACT, { name: "press", risk: "destructive" as const }, { name: "type_in", risk: "write" as const }];
  const press = (describe: (ref: string) => string | undefined | Promise<string | undefined>, ran: string[] = []) => defineTool<{ ref: string }>({
    name: "press",
    toolClass: "destructive",
    parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    describe: ({ ref }) => describe(ref),
    run: ({ ref }) => {
      ran.push(ref);
      return `pressed ${ref}`;
    },
  });

  it("is on the card as the tool says it, read when the user is asked", async () => {
    const ran: string[] = [];
    const s = await setup({ agents: [{ slug: "docs", contract: CONTRACT }], model: once({ name: "press", arguments: { ref: "e5" } }) },
      () => ApprovalDecision.approve(), (b) => b.addTools(press((ref) => `button "Send"\n on mail.example.com (${ref})`, ran)));
    const session = await s.agent.startSession();
    await session.send("send it");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ toolName: "press", target: 'button "Send" on mail.example.com (e5)', arguments: { ref: "e5" } });
    expect(ran).toEqual(["e5"]);
  });

  it("a tool that fails to say, or says nothing, leaves the card with the arguments, and the call still asks", async () => {
    for (const describe of [() => { throw new Error("gone"); }, () => undefined, () => "  "]) {
      const s = await setup({ agents: [{ slug: "docs", contract: CONTRACT }], model: once({ name: "press", arguments: { ref: "e5" } }) },
        () => ApprovalDecision.approve(), (b) => b.addTools(press(describe)));
      const session = await s.agent.startSession();
      await session.send("send it");
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]!.target).toBeUndefined();
    }
  });

  it("is clipped to one line of 300 characters", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: CONTRACT }], model: once({ name: "press", arguments: { ref: "e5" } }) },
      () => ApprovalDecision.approve(), (b) => b.addTools(press(() => "x".repeat(500))));
    const session = await s.agent.startSession();
    await session.send("send it");
    expect(s.asked[0]!.target).toHaveLength(300);
    expect(s.asked[0]!.target!.endsWith("…")).toBe(true);
  });

  it("is not asked for when nobody is asked: a call allowed for this chat runs without it", async () => {
    let described = 0;
    const typeIn = defineTool<{ ref: string }>({
      name: "type_in",
      toolClass: "write",
      parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      describe: ({ ref }) => {
        described++;
        return `field ${ref}`;
      },
      run: ({ ref }) => `typed into ${ref}`,
    });
    const s = await setup({ agents: [{ slug: "docs", contract: CONTRACT }], model: once({ name: "type_in", arguments: { ref: "e2" } }) },
      () => ApprovalDecision.approveForSession(), (b) => b.addTools(typeIn));
    const session = await s.agent.startSession();
    await session.send("type");
    await session.send("type again");
    expect(s.asked).toHaveLength(1);
    expect(described).toBe(1);
  });
});

describe("the page contract", () => {
  it("keeps the helper's classes", () => {
    expect(PAGE_CONTRACT.map((c) => c.risk)).toEqual(["read", "write", "destructive"]);
  });
});
