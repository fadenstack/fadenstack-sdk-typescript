import { describe, expect, it, vi } from "vitest";
import { ApprovalDecision, EntryTypes, MemoryApprovalStore } from "@fadenstack/agents";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";
import { setup } from "./helpers.js";

const once: FakeModel = request => lastToolResults(request).size ? { text: "Finished" }
  : { toolCalls: [{ name: "write_page", arguments: { page: 8, text: "New content" } }] };

describe("0.7 approval restrictions", () => {
  it("does not reuse or create a standing approval the agent disallows", async () => {
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await setup({ model: once }, () => ApprovalDecision.approveAlways(), builder => builder.useApprovalStore(store));
    const get = s.client.agent!.getProfile.bind(s.client.agent);
    vi.spyOn(s.client.agent!, "getProfile").mockImplementation(async signal => ({ ...await get(signal),
      approvals: { standing: [], longestGrantMinutes: 0, grantClasses: [] } }));
    try {
      const session = await s.agent.startSession();
      await session.send("write");
      await session.send("write again");
      expect(s.asked).toHaveLength(2);
      expect(s.asked[0]).toMatchObject({ canAllowAlways: false, canAllowForSession: false });
      expect(session.transcript.filter(e => e.type === EntryTypes.approvalDecision).map(e => e.data["scope"])).toEqual(["once", "once"]);
    } finally { await s.agent.dispose(); }
  });

  it("contract always asks in Auto even without a server event, despite a stored approval", async () => {
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await setup({ model: once, agents: [{ slug: "docs", contract: [{ name: "write_page", risk: "write", approval: "always" }] }] },
      () => ApprovalDecision.approveForSession(), builder => builder.useApprovalStore(store));
    try {
      const session = await s.agent.startSession("auto");
      await session.send("write");
      await session.send("write again");
      expect(s.asked).toHaveLength(2);
      expect(s.asked[0]).toMatchObject({ requiredByRule: true, canAllowAlways: false, canAllowForSession: false });
    } finally { await s.agent.dispose(); }
  });

  it.each([true, false])("answers gateway destructive approvals explicitly once: approved=%s", async approved => {
    const s = await setup({ model: () => ({ gatewayTool: { name: "mcp_wiki.delete", approval: { message: "Delete", rule: false, toolClass: "destructive" } }, text: "Finished" }) },
      () => approved ? ApprovalDecision.approveAlways() : ApprovalDecision.deny());
    try {
      const session = await s.agent.startSession();
      await session.send("delete");
      const answers = s.gateway.requests.filter(r => /\/approvals\//.test(r.path));
      expect(answers).toHaveLength(1);
      expect(answers[0]!.body).toEqual({ approved, scope: "once" });
    } finally { await s.agent.dispose(); }
  });
});
