import { describe, expect, it } from "vitest";

import { ApprovalDecision, EntryTypes, MemoryApprovalStore, defineTool, type ChatSession } from "@fadenstack/agents";
import { OPEN_WORLD_ENFORCED, conversationOnly, decideTool, type ToolClass, type ToolMode } from "@fadenstack/client";
import { lastToolResults, type FakeModel, type FakeReply } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup } from "./helpers.js";

// Below auto, a call to an open-world tool asks, and the person may allow it for the rest of the conversation; auto and
// bypass run it. The mark is the stricter of the tool's own and the gateway's (sdk/51 F08 §4, the owner, 14 Nov 2026).
// The .NET SDK's OpenWorldTests.

const ran: string[] = [];
const searchNews = defineTool<{ query: string }>({ name: "search_news", description: "Searches the news.", toolClass: "read", openWorld: true,
  parameters: { type: "object", properties: { query: { type: "string" } } }, run: ({ query }) => { ran.push("search_news"); return `news on ${query}`; } });
const searchWeb = defineTool<{ query: string }>({ name: "search_web", description: "Searches the web.", toolClass: "write", openWorld: true,
  parameters: { type: "object", properties: { query: { type: "string" } } }, run: ({ query }) => { ran.push("search_web"); return `results for ${query}`; } });
const CONTRACT = [...PAGE_CONTRACT, { name: "search_news", risk: "read" as const }, { name: "search_web", risk: "write" as const }];
const agents = [{ slug: "docs", contract: CONTRACT }];

/** A model that makes `call` once per turn, then answers with what the tool said. */
function eachTurn(call: { name: string; arguments: Record<string, unknown>; id?: string }, extra: Partial<FakeReply> = {}): FakeModel {
  return (request) => (lastToolResults(request).size ? { text: "Done." } : { text: "On it.", toolCalls: [call], ...extra });
}

const decisions = (session: ChatSession) =>
  session.transcript.filter((e) => e.type === EntryTypes.approvalDecision).map((e) => e.data);

describe("open-world calls", () => {
  const table: [ToolMode, ToolClass, string][] = [
    ["off", "read", "hidden"], ["read_only", "read", "ask"], ["ask", "read", "ask"], ["auto", "read", "run"], ["bypass", "read", "run"],
    ["read_only", "write", "hidden"], ["ask", "write", "ask"], ["auto", "write", "run"], ["bypass", "write", "run"],
    ["auto", "destructive", "ask"], ["auto", "unknown", "ask"],
  ];
  for (const [mode, toolClass, expected] of table) {
    it(`an open-world ${toolClass} tool in ${mode}: ${expected}`, () => {
      expect(decideTool(mode, toolClass, undefined, true)).toBe(expected);
      expect(conversationOnly(mode, true)).toBe(["off", "read_only", "ask"].includes(mode));
      expect(conversationOnly(mode, false)).toBe(false);
    });
  }

  it("without the mark a read tool runs as before, and the contract's never still runs it", () => {
    expect(OPEN_WORLD_ENFORCED).toBe(true);
    expect(decideTool("ask", "read")).toBe("run");
    expect(decideTool("read_only", "read", undefined, false)).toBe("run");
    expect(decideTool("ask", "read", "never", true)).toBe("run");
  });

  for (const mode of ["ask", "read_only"] as const) {
    it(`an open-world read tool asks in ${mode}, for this conversation at most`, async () => {
      ran.length = 0;
      const s = await setup({ agents, model: eachTurn({ name: "search_news", arguments: { query: "rates" } }) },
        () => ApprovalDecision.approveForSession(), (b) => b.addTools(searchNews));
      try {
        const first = await s.agent.startSession(mode);
        await first.send("News?");
        await first.send("Again?");
        const second = await s.agent.startSession(mode);
        await second.send("Later?");
        expect(ran).toEqual(["search_news", "search_news", "search_news"]);
        expect(s.asked).toHaveLength(2); // the first conversation asked once; the second asked again
        for (const request of s.asked) {
          expect(request).toMatchObject({ toolClass: "read", openWorld: true, canAllowForSession: true, canAllowAlways: false });
          expect(request.grantDurations).toBeUndefined();
          expect(request.reason).toMatch(/^What 'search_news' is given leaves the organisation/);
        }
      } finally { await s.agent.dispose(); }
    });
  }

  it("in auto an open-world tool runs unasked", async () => {
    ran.length = 0;
    const s = await setup({ agents, model: (request) => lastToolResults(request).size ? { text: "Done." }
      : { toolCalls: [{ id: "c1", name: "search_news", arguments: { query: "a" } }, { id: "c2", name: "search_web", arguments: { query: "b" } }] } },
      () => ApprovalDecision.approve(), (b) => b.addTools(searchNews, searchWeb));
    try {
      await (await s.agent.startSession("auto")).send("Search.");
      expect(ran).toEqual(["search_news", "search_web"]);
      expect(s.asked).toHaveLength(0);
    } finally { await s.agent.dispose(); }
  });

  it("an always saved before does not answer an open-world call below auto, and always is not offered", async () => {
    ran.length = 0;
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "search_web", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await setup({ agents, model: eachTurn({ name: "search_web", arguments: { query: "rates" } }) },
      () => ApprovalDecision.approveAlways(), (b) => b.addTools(searchWeb).useApprovalStore(store));
    try {
      const session = await s.agent.startSession("ask");
      await session.send("Search.");
      expect(s.asked).toHaveLength(1); // the stored "always" did not answer it
      expect(s.asked[0]).toMatchObject({ toolClass: "write", openWorld: true, canAllowForSession: true, canAllowAlways: false });
      expect(ran).toEqual(["search_web"]);
      expect(decisions(session).map((d) => d["scope"])).toEqual(["once"]); // the handler's "always" counted once
    } finally { await s.agent.dispose(); }
  });

  it("the gateway's open-world mark makes a tool open-world: the stricter mark wins", async () => {
    const mark = (openWorld: boolean): Partial<FakeReply> => ({ events: [{ type: "CUSTOM", name: "faden.approval_required", value: {
      toolCallId: "call-1", toolCallName: "read_page", message: "This tool needs your approval in this chat's tool mode.", toolClass: "read",
      rule: false, ...(openWorld ? { openWorld: true } : {}) } }] });
    for (const openWorld of [true, false]) {
      const s = await setup({ agents, model: eachTurn({ id: "call-1", name: "read_page", arguments: { page: 1 } }, mark(openWorld)) },
        () => ApprovalDecision.approveForSession());
      try {
        await (await s.agent.startSession("ask")).send("Read page 1.");
        if (openWorld) {
          expect(s.asked).toHaveLength(1);
          expect(s.asked[0]).toMatchObject({ toolName: "read_page", toolClass: "read", openWorld: true, canAllowForSession: true, canAllowAlways: false });
        } else {
          expect(s.asked).toHaveLength(0); // without the word, a read tool runs unasked in ask
        }
      } finally { await s.agent.dispose(); }
    }
  });

  it("a gateway tool the gateway holds open-world is offered for the chat but not always", async () => {
    const s = await setup({ model: () => ({ gatewayTool: { name: "mcp_search.web", approval: { message: "The tool mode asks.", rule: false, toolClass: "read", openWorld: true } }, text: "Found." }) },
      () => ApprovalDecision.approveAlways());
    try {
      await (await s.agent.startSession("ask")).send("Search the web.");
      expect(s.asked).toMatchObject([{ source: "gateway", toolClass: "read", openWorld: true, canAllowForSession: true, canAllowAlways: false }]);
      expect(s.gateway.approvals).toMatchObject([{ approved: true }]);
    } finally { await s.agent.dispose(); }
  });
});
