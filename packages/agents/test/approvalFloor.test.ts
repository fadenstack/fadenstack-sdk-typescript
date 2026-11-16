import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolMode } from "@fadenstack/client";
import { ApprovalFloor, MemoryApprovalStore, defineTool, type ChatSession } from "@fadenstack/agents";
import { MemoryMcpServerStore, mcpModule } from "@fadenstack/mcp";
import { FakeMcpServer } from "../../mcp/test/fakeServer.js";
import { server as mcpServer } from "../../mcp/test/rig.js";
import { Card, OFFERED, Script, fixture, grantUsed, ruleMark, type Fixture } from "./grantHelpers.js";
import { PAGE_CONTRACT, setup } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The approval floor, "the never-skip list" (sdk/38 §4.3; sdk/51 F08 §2, owner, 16 Nov): each item holds at every level.
 * It records the rule the SDK and the gateway already follow; these tests change no behaviour. Bypass is real: the server's
 * grant with the second sign-in (`startBypass`), and every case checks that the turn ran in the level it names. Port of the
 * .NET `ApprovalFloorTests`.
 */
const LEVELS = ["ask", "auto", "bypass"] as const satisfies readonly ToolMode[];
type Level = (typeof LEVELS)[number];

/** A session at the level; in `bypass` the conversation's own Bypass grant is made through the card and the second sign-in. */
async function open(s: { agent: Fixture["agent"] }, level: Level): Promise<ChatSession> {
  if (level !== "bypass") {
    const session = await s.agent.startSession(level);
    expect(session.effectiveToolMode).toBe(level);
    return session;
  }
  const session = await s.agent.startSession("ask");
  expect(await session.startBypass()).not.toBeNull();
  expect([session.toolMode, session.effectiveToolMode]).toEqual(["bypass", "bypass"]);
  return session;
}

/** What the server saw: every request of the turn carried the level, so the turn really ran in it. */
function ranIn(s: { gateway: Fixture["gateway"] }, level: Level): void {
  expect(s.gateway.modelCalls.length).toBeGreaterThan(0);
  expect(s.gateway.modelCalls.map((c) => c.toolMode)).toEqual(s.gateway.modelCalls.map(() => level));
}

/** The gateway says the conversation's Bypass grant covers the call (only in Bypass), as the real one would. */
const covering = (session: ChatSession, level: Level, id: string, name: string): Record<string, unknown>[] =>
  level === "bypass" ? [grantUsed(id, name, session.bypass!.id)] : [];

const stamp = defineTool<Record<string, never>>({
  name: "stamp",
  description: "Stamps the drawing.",
  parameters: { type: "object", properties: {} },
  run: () => "stamped",
});

describe("the approval floor: the list", () => {
  it("holds exactly the seven items, in the order of sdk/38 §4.3, with the two not yet marked and destructive apart", () => {
    expect(ApprovalFloor.neverSkipped).toEqual([
      "refused", "ask_first_rule", "author_always", "physical", "open_world_tainted", "mcp_server_question", "gateway_held",
    ]);
    expect(ApprovalFloor.neverSkipped).toEqual([
      ApprovalFloor.refused, ApprovalFloor.askFirstRule, ApprovalFloor.authorAlways, ApprovalFloor.physical,
      ApprovalFloor.openWorldTainted, ApprovalFloor.mcpServerQuestion, ApprovalFloor.gatewayHeld,
    ]);
    expect(ApprovalFloor.notMarkedYet).toEqual([ApprovalFloor.physical, ApprovalFloor.openWorldTainted]);
    expect(ApprovalFloor.destructiveOrUnclassified).toBe("destructive_or_unclassified");
    expect(ApprovalFloor.neverSkipped).not.toContain(ApprovalFloor.destructiveOrUnclassified);
    expect(Object.isFrozen(ApprovalFloor)).toBe(true);
    expect(Object.isFrozen(ApprovalFloor.neverSkipped)).toBe(true);
  });

  it("is listed on the Approvals page, item by item", () => {
    const page = readFileSync(new URL("../../../docs/approvals.md", import.meta.url), "utf8");
    for (const id of [...ApprovalFloor.neverSkipped, ApprovalFloor.destructiveOrUnclassified]) {
      expect(page, id).toContain("`" + id + "`");
    }
  });
});

describe.each(LEVELS)("the approval floor at %s", (level) => {
  it("refused: a call the gateway denies does not run and nobody is asked", async () => {
    const s = await fixture();
    const session = await open(s, level);
    s.script.reply({
      events: covering(session, level, "call-1", "write_page"),
      deniedTool: { name: "write_page", message: "Writing is off.", callId: "call-1" },
      toolCalls: [{ id: "call-1", name: "write_page", arguments: { page: 8, text: "x" } }],
    }).says("Not written.");

    const result = await session.send("Write page 8.");

    expect(s.pages.pages.get(8)).toBe("Figure F2");
    expect(s.card.asked).toEqual([]);
    expect(result.outcome).toBe("tool_denied");
    ranIn(s, level);
  });

  it("ask_first_rule: a call the gateway marks rule: true asks, over an always the person kept and under the Bypass grant", async () => {
    const approvals = new MemoryApprovalStore();
    await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString(), source: "host" });
    const s = await fixture({ configure: (b) => b.useApprovalStore(approvals) });
    const session = await open(s, level);
    s.script.reply({
      events: [...covering(session, level, "call-1", "write_page"), ruleMark("call-1", "write_page", "Writing needs a second look.")],
      toolCalls: [{ id: "call-1", name: "write_page", arguments: { page: 8, text: "x" } }],
    }).says("Ok.");

    await session.send("Write page 8.");

    expect(s.card.asked).toHaveLength(1);
    expect(s.card.asked[0]).toMatchObject({ toolName: "write_page", requiredByRule: true, canAllowAlways: false, canAllowForSession: false });
    expect(s.pages.pages.get(8)).toBe("Figure F2"); // the card said no
    ranIn(s, level);
  });

  it("author_always: a contract tool with approval: always asks, over an always the person kept and under the Bypass grant", async () => {
    const approvals = new MemoryApprovalStore();
    await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString(), source: "host" });
    const s = await fixture({
      contract: [{ name: "read_page", risk: "read" }, { name: "write_page", risk: "write", approval: "always" }, { name: "delete_page", risk: "destructive" }],
      configure: (b) => b.useApprovalStore(approvals),
    });
    const session = await open(s, level);
    s.script.reply({
      events: covering(session, level, "call-1", "write_page"),
      toolCalls: [{ id: "call-1", name: "write_page", arguments: { page: 8, text: "x" } }],
    }).says("Ok.");

    await session.send("Write page 8.");

    expect(s.card.asked).toHaveLength(1);
    expect(s.card.asked[0]).toMatchObject({ toolName: "write_page", requiredByRule: true, canAllowAlways: false, canAllowForSession: false });
    expect(s.pages.pages.get(8)).toBe("Figure F2");
    ranIn(s, level);
  });

  it("gateway_held: a gateway tool the gateway holds asks the person, who answers the gateway", async () => {
    const s = await fixture({ card: new Card(true, false) });
    const session = await open(s, level);
    // A call the gateway holds is one it did not cover: it sends no grant_used for it.
    s.script.reply({
      gatewayTool: { callId: "gw-1", name: "mcp_github.comment", approval: { message: "Commenting needs your OK.", rule: false, toolClass: "write" } },
      text: "Done.",
    });

    await session.send("Comment on the issue.");

    expect(s.card.asked).toMatchObject([{ toolName: "mcp_github.comment", source: "gateway" }]);
    const answer = s.gateway.requests.find((r) => r.path.includes("/approvals/"))!;
    expect(answer.body).toMatchObject({ approved: false }); // the person's answer, not the SDK's own
    ranIn(s, level);
  });

  it.each(["delete_page", "stamp"])("destructive_or_unclassified: %s asks in Ask and Auto; in Bypass it runs unasked only where the grant covers it", async (tool) => {
    const s = await fixture({
      contract: [...PAGE_CONTRACT, { name: "stamp" }],
      configure: (b) => b.addTools(stamp),
    });
    const session = await open(s, level);
    const args = tool === "delete_page" ? { page: 7 } : {};
    const ran = () => (tool === "delete_page" ? s.pages.deleted.length : 0);
    s.script.reply({ events: covering(session, level, "call-1", tool), toolCalls: [{ id: "call-1", name: tool, arguments: args }] }).says("Done.");

    await session.send("Go.");

    if (level === "bypass") {
      expect(s.card.asked).toEqual([]); // the conversation's Bypass grant covered it
      expect(s.grants.reports).toEqual([{ grant: session.bypass!.id, calls: ["call-1"] }]);
      expect(ran()).toBe(tool === "delete_page" ? 1 : 0);
    } else {
      expect(s.card.asked).toHaveLength(1);
      expect(s.card.asked[0]).toMatchObject({ toolName: tool, canAllowAlways: false, canAllowForSession: false });
      expect(ran()).toBe(0);
    }
    ranIn(s, level);
  });

  it("destructive_or_unclassified: without the grant's cover, Bypass asks as well", async () => {
    if (level !== "bypass") return;
    const s = await fixture();
    const session = await open(s, level);
    s.script.calls({ id: "call-1", name: "delete_page", arguments: { page: 7 } }).says("Not deleted.");

    await session.send("Delete page 7.");

    expect(s.card.asked).toHaveLength(1);
    expect(s.pages.deleted).toEqual([]);
    ranIn(s, level);
  });

  it("mcp_server_question: the client declares no elicitation, so a server cannot ask, and nothing answers for the person", async () => {
    const fake = new FakeMcpServer();
    const sent: string[] = [];
    const store = new MemoryMcpServerStore();
    await store.save(mcpServer("notes", fake.urls.both));
    const module = mcpModule({
      store,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === "string") sent.push(init.body);
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    const script = new Script();
    const card = new Card(true, true);
    const s = await setup(
      { model: script.model, grants: { approvals: OFFERED }, agents: [{ slug: "docs", contract: [], maxLevel: "bypass", localMcpMode: "allow" }] },
      undefined,
      (b) => b.useApprovals(card).use(module),
    );
    s.agent.stepUps.delay = () => Promise.resolve();
    const session = await open(s, level);
    script.calls({ id: "c1", name: "find_tool", arguments: { query: "echo text" } }).calls({ id: "c2", name: "echo", arguments: { text: "hi" } }).says("Done.");

    const result = await session.send("Echo hi.");

    expect(result.outcome).toBe("completed");
    expect(fake.calls).toEqual([{ tool: "echo", args: { text: "hi" } }]);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join("\n").toLowerCase()).not.toContain("elicitation");
    ranIn(s, level);
  });
});
