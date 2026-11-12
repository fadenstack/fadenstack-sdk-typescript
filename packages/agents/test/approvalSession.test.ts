import { describe, expect, it } from "vitest";
import { ApprovalDecision, EntryTypes, type ApprovalRequest } from "@fadenstack/agents";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";
import { setup } from "./helpers.js";

// S-1 (.NET ApprovalRequest.SessionId / TurnId, AgentSession.Approvals): a request names its session, so a screen with
// several chats hands it to the chat that owns it.

const write: FakeModel = request => lastToolResults(request).size ? { text: "Done." }
  : { toolCalls: [{ name: "write_page", arguments: { page: 8, text: "x" } }] };

describe("approval requests carry their session", () => {
  it("names the session and the turn, for a tool the agent asks about", async () => {
    const s = await setup({ model: write });
    try {
      const session = await s.agent.startSession();
      const result = await session.send("write");
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]).toMatchObject({ sessionId: session.id, turnId: result.turnId, toolName: "write_page" });
    } finally { await s.agent.dispose(); }
  });

  it("names the session for a tool the gateway holds, and in the record of the event", async () => {
    const s = await setup({ model: r => lastToolResults(r).size ? { text: "Done." }
      : { gatewayTool: { name: "mcp_wiki.delete", approval: { message: "Delete", rule: false, toolClass: "destructive" } }, text: "Finished" } });
    try {
      const session = await s.agent.startSession();
      const events: ApprovalRequest[] = [];
      for await (const e of session.stream("delete")) if (e.type === "approval_requested") events.push(e.request);
      expect(s.asked[0]).toMatchObject({ sessionId: session.id, source: "gateway" });
      expect(events[0]!.sessionId).toBe(session.id);
    } finally { await s.agent.dispose(); }
  });

  it("two chats of one agent ask in their own sessions", async () => {
    const s = await setup({ model: write });
    try {
      const a = await s.agent.startSession();
      const b = await s.agent.startSession();
      await a.send("write");
      await b.send("write");
      expect(s.asked.map(r => r.sessionId)).toEqual([a.id, b.id]);
      expect(a.id).not.toBe(b.id);
      expect(a.transcript.filter(e => e.type === EntryTypes.approvalDecision)).toHaveLength(1);
    } finally { await s.agent.dispose(); }
  });

  it("a session's own handler is asked in place of the agent's", async () => {
    const s = await setup({ model: write });
    try {
      const mine: ApprovalRequest[] = [];
      const session = await s.agent.startSession();
      session.approvals = { request: async r => { mine.push(r); return ApprovalDecision.approve(); } };
      await session.send("write");
      expect(mine).toHaveLength(1);
      expect(s.asked).toHaveLength(0);
      expect(s.pages.pages.get(8)).toBe("x");
    } finally { await s.agent.dispose(); }
  });
});
