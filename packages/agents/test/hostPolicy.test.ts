import { describe, expect, it, vi } from "vitest";
import { ApprovalDecision, MemoryApprovalStore, StageOrder } from "@fadenstack/agents";
import { HOST_TOOL_DISPATCH_FEATURE, type AgentApprovals, type AgentPrincipal, type HostToolDecision } from "@fadenstack/client";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";
import { setup } from "./helpers.js";

const principal: AgentPrincipal = { tenantId: "tenant", userId: "user", agentId: "agent", deviceId: "device" };
const prepared: HostToolDecision = { decision: "ask", toolClass: "write", effectiveToolMode: "ask", requiredByRule: false,
  message: "Review this call", profileStamp: "a".repeat(64), argumentsStamp: "b".repeat(64), decisionStamp: "c".repeat(64), principal };
const model: FakeModel = request => lastToolResults(request).size ? { text: "Finished" }
  : { toolCalls: [{ id: "model-call", name: "write_page", arguments: { page: 8, text: "Reviewed content" } }] };

async function fixture(answer = true, configure?: Parameters<typeof setup>[2], required = true) {
  const s = await setup({ model }, () => ({ approved: answer }), builder => {
    if (required) builder.requireHostToolPolicyChecks();
    return configure ? configure(builder) : builder;
  });
  const resource = s.client.agent!;
  const original = resource.getProfile.bind(resource);
  const controls: { approvals: AgentApprovals; version?: number; feature: boolean } = {
    approvals: { standing: null, longestGrantMinutes: 120, grantClasses: ["read", "write"] }, feature: true,
  };
  vi.spyOn(resource, "getProfile").mockImplementation(async signal => {
    const p = await original(signal);
    return { ...p, principal, version: controls.version ?? p.version, approvals: controls.approvals,
      features: [...p.features, ...(controls.feature ? [HOST_TOOL_DISPATCH_FEATURE] : [])] };
  });
  const check = vi.spyOn(resource, "checkHostTool").mockResolvedValue(prepared);
  const session = await s.agent.startSession();
  return { ...s, session, check, controls };
}

describe("fresh central policy for model-requested host calls", () => {
  it("automatically negotiates the advertised check without an app opt-in", async () => {
    const s = await fixture(true, undefined, false);
    try {
      expect(s.agent.hostToolPolicyChecks).toBe(true);
      await s.session.send("write");
      expect(s.check.mock.calls.map(([r]) => r.phase)).toEqual(["prepare", "dispatch"]);
    } finally { await s.agent.dispose(); }
  });

  it("refreshes standing restrictions before considering a stored approval", async () => {
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await fixture(true, b => b.useApprovalStore(store));
    try {
      s.controls.approvals = { standing: [], longestGrantMinutes: 0, grantClasses: [] };
      await s.session.send("write");
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]).toMatchObject({ canAllowAlways: false, canAllowForSession: false });
    } finally { await s.agent.dispose(); }
  });

  it("checks prepare/dispatch under the model origin and runs only the reviewed arguments", async () => {
    const s = await fixture();
    try {
      await s.session.send("write");
      expect(s.pages.pages.get(8)).toBe("Reviewed content");
      expect(s.asked).toHaveLength(1);
      expect(s.check.mock.calls.map(([r]) => [r.origin, r.phase, r.callId])).toEqual([
        ["model_tool", "prepare", "model-call"], ["model_tool", "dispatch", "model-call"],
      ]);
      expect(s.check.mock.calls[1]![0].arguments).toEqual({ page: 8, text: "Reviewed content" });
    } finally { await s.agent.dispose(); }
  });

  it("fails startup on an old server when the host requires central dispatch checks", async () => {
    const s = await setup({}, undefined, b => b.requireHostToolPolicyChecks());
    await expect(s.agent.startSession()).rejects.toThrow("does not advertise support");
    expect(s.gateway.modelCalls).toHaveLength(0);
    await s.agent.dispose();
  });

  it("central Deny and local Deny produce no native effect", async () => {
    for (const central of [true, false]) {
      const s = await fixture(central);
      try {
        if (central) s.check.mockResolvedValue({ ...prepared, decision: "deny" });
        await s.session.send("write");
        expect(s.pages.pages.get(8)).toBe("Figure F2");
        expect(s.check).toHaveBeenCalledTimes(1);
        expect(s.asked).toHaveLength(central ? 0 : 1);
      } finally { await s.agent.dispose(); }
    }
  });

  it.each(["deny", "principal", "profileStamp", "argumentsStamp", "decisionStamp"] as const)("refuses %s drift after approval", async field => {
    const s = await fixture();
    try {
      const changed = field === "deny" ? { ...prepared, decision: "deny" as const }
        : field === "principal" ? { ...prepared, principal: { ...principal, userId: "other" } }
          : { ...prepared, [field]: "d".repeat(64) };
      s.check.mockResolvedValueOnce(prepared).mockResolvedValueOnce(changed);
      await s.session.send("write");
      expect(s.pages.pages.get(8)).toBe("Figure F2");
      expect(s.check).toHaveBeenCalledTimes(2);
    } finally { await s.agent.dispose(); }
  });

  it.each(["prepare", "dispatch"] as const)("fails closed on %s timeout without another send", async phase => {
    const s = await fixture();
    try {
      if (phase === "dispatch") s.check.mockResolvedValueOnce(prepared);
      s.check.mockRejectedValue(new Error("Policy timeout"));
      await s.session.send("write");
      expect(s.pages.pages.get(8)).toBe("Figure F2");
      expect(s.check).toHaveBeenCalledTimes(phase === "prepare" ? 1 : 2);
    } finally { await s.agent.dispose(); }
  });

  it("does not disclose arguments transformed by a local module to the dispatch endpoint", async () => {
    const s = await fixture(true, b => b.addToolStage(StageOrder.pii, {
      invoke: (call, next) => next({ ...call, arguments: { ...call.arguments, text: "Local unmasked value" } }),
    }));
    try {
      await s.session.send("write");
      expect(s.pages.pages.get(8)).toBe("Figure F2");
      expect(s.check).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(s.check.mock.calls)).not.toContain("Local unmasked value");
    } finally { await s.agent.dispose(); }
  });

  it.each(["limits", "version", "feature", "mode"] as const)("refuses %s changes while the approval is open", async change => {
    const s = await fixture(true, b => b.useApprovals(async () => {
      if (change === "limits") s.controls.approvals = { standing: [], longestGrantMinutes: 0, grantClasses: [] };
      if (change === "version") s.controls.version = 2;
      if (change === "feature") s.controls.feature = false;
      if (change === "mode") s.session.toolMode = "read_only";
      return { approved: true };
    }));
    try {
      if (change === "mode") s.check.mockImplementation(async check => check.phase === "dispatch" ? { ...prepared, decision: "deny" } : prepared);
      await s.session.send("write");
      expect(s.pages.pages.get(8)).toBe("Figure F2");
      if (change === "mode") expect(s.check.mock.calls[1]![0].toolMode).toBe("read_only");
    } finally { await s.agent.dispose(); }
  });

  it("preserves the individual floor against a stored approval and an overbroad handler answer", async () => {
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString() });
    const s = await fixture(true, b => b.useApprovalStore(store).useApprovals(async () => ApprovalDecision.approveAlways()));
    try {
      s.check.mockResolvedValue({ ...prepared, requiredByRule: true });
      await s.session.send("write");
      expect(s.session.approvedForSession.size).toBe(0);
      expect(s.pages.pages.get(8)).toBe("Reviewed content");
      expect(s.check).toHaveBeenCalledTimes(2);
    } finally { await s.agent.dispose(); }
  });

  it("Stop aborts pending approval without reaching dispatch", async () => {
    const controller = new AbortController();
    const s = await fixture(true, b => b.useApprovals(async () => { controller.abort(); return { approved: true }; }));
    try {
      await s.session.send("write", { signal: controller.signal }).catch(() => {});
      expect(s.pages.pages.get(8)).toBe("Figure F2");
      expect(s.check).toHaveBeenCalledTimes(1);
    } finally { await s.agent.dispose(); }
  });
});
