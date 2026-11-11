import { describe, expect, it, vi } from "vitest";
import { ApprovalDecision, EntryTypes, GrantPlace, defineTool, type ApprovalRequest } from "@fadenstack/agents";
import { HOST_TOOL_DISPATCH_FEATURE, type AgentGrant, type AgentPrincipal, type HostToolDecision } from "@fadenstack/client";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";
import { setup } from "./helpers.js";

const id = "11111111-1111-4111-8111-111111111111";
const principal: AgentPrincipal = { tenantId: "tenant", userId: "user", agentId: "agent-1", deviceId: "device" };
const policy: HostToolDecision = { decision: "ask", toolClass: "write", effectiveToolMode: "ask", requiredByRule: false,
  message: "Review", profileStamp: "a".repeat(64), argumentsStamp: "b".repeat(64), decisionStamp: "c".repeat(64), principal };
function initial(): AgentGrant {
  return { id, kind: "time", status: "active", agentId: principal.agentId, agentVersion: 1, deviceId: "device", conversationId: null,
    scope: { tools: ["write_resource"], classes: ["read", "write"] }, issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1800_000).toISOString(), remainingS: 1800, maxCalls: 20, callsUsed: 1,
    pausedAt: null, revokedAt: null, revokedBy: null, evidenceLevel: "decisions", stepUp: null, serverNow: new Date().toISOString(), narrowed: [] };
}
const marker = { type: "CUSTOM", name: "faden.grant_used", value: { toolCallId: "write-1", toolCallName: "write_resource", grantId: id } };

async function fixture(options: { marked?: boolean; answer?: (r: ApprovalRequest) => ReturnType<typeof ApprovalDecision.approve>;
  destructive?: boolean; resolve?: boolean } = {}) {
  const invoke = vi.fn(() => "Native result");
  const toolClass = options.destructive ? "destructive" : "write";
  const model: FakeModel = request => lastToolResults(request).size ? { text: "Finished" } : {
    ...(options.marked === false ? {} : { events: [marker] }),
    toolCalls: [{ id: "write-1", name: "write_resource", arguments: { resource_id: "nextcloud:files:2", text: "Reviewed content" } }],
  };
  const s = await setup({ model, agents: [{ slug: "docs", contract: [{ name: "write_resource", risk: toolClass }] }] },
    options.answer ?? (() => ApprovalDecision.deny()), b => {
      b.requireHostToolPolicyChecks().addTools(defineTool({ name: "write_resource", toolClass,
        parameters: { type: "object", properties: { resource_id: { type: "string" }, text: { type: "string" } },
          required: ["resource_id", "text"], additionalProperties: false }, run: invoke }));
      return options.resolve ? b.useGrantPlaceResolver(async place => place) : b;
    });
  const api = s.client.agent!, original = api.getProfile.bind(api);
  vi.spyOn(api, "getProfile").mockImplementation(async signal => {
    const profile = await original(signal);
    return { ...profile, principal, features: [...profile.features, "approval_scopes.grant", HOST_TOOL_DISPATCH_FEATURE],
      approvals: { standing: ["time", "grant"] as ("time" | "grant")[], longestGrantMinutes: 60, grantClasses: ["read", "write"] as ("read" | "write")[] },
      hostToolContract: profile.hostToolContract.map(entry => ({ ...entry, targetType: "document" as const, targetArgument: "/resource_id" })) };
  });
  const check = vi.spyOn(api, "checkHostTool").mockResolvedValue({ ...policy, toolClass });
  const grant = initial();
  const get = vi.spyOn(api, "getGrant").mockImplementation(async () => structuredClone(grant));
  const create = vi.spyOn(api, "createGrant").mockImplementation(async () => structuredClone({ ...grant, callsUsed: 0 }));
  const session = await s.agent.startSession();
  return { ...s, invoke, check, grant, get, create, session, api };
}

describe("server-held grant execution", () => {
  it("a repeated call id in one model round cannot spend one grant reservation twice", async () => {
    const s = await fixture();
    try {
      s.gateway.setModel(request => lastToolResults(request).size ? { text: "Finished" } : {
        events: [marker], toolCalls: [1, 2].map(() => ({ id: "write-1", name: "write_resource", arguments: { resource_id: "nextcloud:files:2", text: "Reviewed" } })),
      });
      await s.session.send("write");
      expect(s.invoke).toHaveBeenCalledOnce();
      expect(s.asked).toHaveLength(1);
    } finally { await s.agent.dispose(); }
  });

  it("a missing grant or a denied card creates no replacement permission", async () => {
    const s = await fixture();
    try {
      s.get.mockRejectedValue(new Error("grant_not_found"));
      await s.session.send("write");
      expect(s.asked).toHaveLength(1);
      expect(s.create).not.toHaveBeenCalled();
      expect(s.invoke).not.toHaveBeenCalled();
    } finally { await s.agent.dispose(); }
  });

  it("malformed snapshots clear cached display state rather than retaining stale authority", async () => {
    const s = await fixture();
    try {
      vi.spyOn(s.api, "listGrants").mockResolvedValue({ data: [s.grant], serverNow: s.grant.serverNow });
      await s.agent.grants.refresh();
      expect(s.agent.grants.live).toHaveLength(1);
      s.agent.grants.snapshot({ serverNow: s.grant.serverNow, grants: [{ id: "invalid" }] });
      expect(s.agent.grants.live).toHaveLength(0);
    } finally { await s.agent.dispose(); }
  });
  it("does not cache a broader or different grant than the person requested", async () => {
    const s = await fixture({ marked: false });
    try {
      s.create.mockResolvedValue({ ...s.grant, remainingS: 3600 });
      await expect(s.agent.grants.grantForTime("write_resource", 30 * 60_000)).rejects.toThrow("exceeds");
      expect(s.agent.grants.live).toHaveLength(0);
      s.create.mockResolvedValue({ ...s.grant, scope: { tools: ["other_tool"] } });
      await expect(s.agent.grants.grantForTime("write_resource", 30 * 60_000)).rejects.toThrow("differs");
      expect(s.agent.grants.live).toHaveLength(0);
    } finally { await s.agent.dispose(); }
  });

  it("stores server-confirmed pause/resume/revoke states and never fabricates an extension", async () => {
    const s = await fixture();
    try {
      vi.spyOn(s.api, "pauseGrant").mockResolvedValue({ ...s.grant, status: "paused" });
      vi.spyOn(s.api, "resumeGrant").mockResolvedValue({ ...s.grant, status: "active" });
      vi.spyOn(s.api, "revokeGrant").mockResolvedValue({ ...s.grant, status: "revoked" });
      const extend = vi.spyOn(s.api, "extendGrant").mockRejectedValue(new Error("grant_at_longest"));
      await s.agent.grants.pause(id);
      expect(s.agent.grants.live[0]?.status).toBe("paused");
      await s.agent.grants.resume(id);
      expect(s.agent.grants.live[0]?.status).toBe("active");
      await expect(s.agent.grants.extend(id, 15 * 60_000)).rejects.toThrow("grant_at_longest");
      expect(extend).toHaveBeenCalledOnce();
      await s.agent.grants.revoke(id);
      expect(s.agent.grants.live).toHaveLength(0);
    } finally { await s.agent.dispose(); }
  });

  it("creates only canonical work grants and refuses a broader returned place", async () => {
    const s = await fixture({ resolve: true });
    try {
      const targets = [{ type: "document" as const, identifiers: ["nextcloud:files:2"] }];
      s.create.mockResolvedValue({ ...s.grant, kind: "work", conversationId: s.session.id,
        scope: { classes: ["write"], targets } });
      const places = [GrantPlace.document("nextcloud:files:2", "Selected native resource")];
      expect((await s.agent.grants.grantWork(places, 30 * 60_000, s.session.id, "Read/write only the selected native resource")).kind).toBe("work");
      s.create.mockResolvedValue({ ...s.grant, kind: "work", conversationId: s.session.id,
        scope: { classes: ["write"], targets: [{ type: "document", identifiers: ["nextcloud:files:99"] }] } });
      await expect(s.agent.grants.grantWork(places, 30 * 60_000, s.session.id, "Only resource 2")).rejects.toThrow("exceeds");
    } finally { await s.agent.dispose(); }
  });
  it("Stop is not held by a grant API that ignores abort", async () => {
    const s = await fixture({ marked: false, answer: () => ApprovalDecision.approveFor(30 * 60_000) });
    const controller = new AbortController();
    try {
      s.create.mockImplementation(() => new Promise(() => {}));
      const running = s.session.send("write", { signal: controller.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(s.create).toHaveBeenCalledOnce());
      controller.abort();
      await running;
      expect(s.invoke).not.toHaveBeenCalled();
    } finally { await s.agent.dispose(); }
  });
  it("requires the matching gateway event and rereads the grant before dispatch", async () => {
    const s = await fixture();
    try {
      await s.session.send("write");
      expect(s.asked).toHaveLength(0);
      expect(s.get).toHaveBeenCalledTimes(2);
      expect(s.invoke).toHaveBeenCalledOnce();
      expect(s.session.transcript.find(e => e.type === EntryTypes.approvalDecision)?.data).toMatchObject({ scope: "grant", asked: false, grant_id: id });
      await s.agent.flush();
      expect(s.agent.lastReportError).toBeUndefined();
    } finally { await s.agent.dispose(); }
  });

  it("a cached active grant alone cannot suppress the approval", async () => {
    const s = await fixture({ marked: false });
    try {
      vi.spyOn(s.api, "listGrants").mockResolvedValue({ data: [s.grant], serverNow: s.grant.serverNow });
      await s.agent.grants.refresh();
      await s.session.send("write");
      expect(s.asked).toHaveLength(1);
      expect(s.get).not.toHaveBeenCalled();
      expect(s.invoke).not.toHaveBeenCalled();
    } finally { await s.agent.dispose(); }
  });

  it.each(["revoked", "paused", "expired"] as const)("%s grants cannot authorize dispatch", async status => {
    const s = await fixture();
    try {
      s.grant.status = status;
      await s.session.send("write");
      expect(s.invoke).not.toHaveBeenCalled();
      expect(s.asked).toHaveLength(1);
    } finally { await s.agent.dispose(); }
  });

  it("revocation after initial coverage still prevents the native effect", async () => {
    const s = await fixture();
    try {
      s.get.mockResolvedValueOnce(structuredClone(s.grant)).mockResolvedValueOnce({ ...s.grant, status: "revoked" });
      await s.session.send("write");
      expect(s.asked).toHaveLength(0);
      expect(s.invoke).not.toHaveBeenCalled();
    } finally { await s.agent.dispose(); }
  });

  it("does not let a server grant suppress an individual destructive action or a rule floor", async () => {
    for (const floor of [false, true]) {
      const s = await fixture({ destructive: !floor });
      try {
        if (floor) s.check.mockResolvedValue({ ...policy, requiredByRule: true });
        await s.session.send("write");
        expect(s.get).not.toHaveBeenCalled();
        expect(s.asked).toHaveLength(1);
        expect(s.asked[0]!.grantDurations).toBeUndefined();
        expect(s.invoke).not.toHaveBeenCalled();
      } finally { await s.agent.dispose(); }
    }
  });

  it("supports the final already-charged call but rejects an impossible budget", async () => {
    for (const impossible of [false, true]) {
      const s = await fixture();
      try {
        s.grant.status = "spent"; s.grant.maxCalls = 1; s.grant.callsUsed = impossible ? 2 : 1;
        await s.session.send("write");
        expect(s.invoke).toHaveBeenCalledTimes(impossible ? 0 : 1);
      } finally { await s.agent.dispose(); }
    }
  });

  it("work coverage needs native canonical resolution and the correct resource", async () => {
    for (const accepted of [false, true]) {
      const s = await fixture({ resolve: accepted });
      try {
        s.grant.kind = "work";
        s.grant.scope = { classes: ["write"], targets: [{ type: "document", identifiers: ["nextcloud:files:2"] }] };
        await s.session.send("write");
        expect(s.invoke).toHaveBeenCalledTimes(accepted ? 1 : 0);
      } finally { await s.agent.dispose(); }
    }
  });

  it("mismatched native resources, principal and conversation do not inherit another grant", async () => {
    for (const changed of ["resource", "device", "conversation"] as const) {
      const s = await fixture({ resolve: true });
      try {
        if (changed === "resource") {
          s.grant.kind = "work";
          s.grant.scope = { classes: ["write"], targets: [{ type: "document", identifiers: ["nextcloud:files:99"] }] };
        }
        if (changed === "device") s.grant.deviceId = "other";
        if (changed === "conversation") s.grant.conversationId = "other";
        await s.session.send("write");
        expect(s.invoke).not.toHaveBeenCalled();
      } finally { await s.agent.dispose(); }
    }
  });

  it("creates time grants only from an offered human answer; narrows to once on failure", async () => {
    for (const failed of [false, true]) {
      const s = await fixture({ marked: false, answer: () => ApprovalDecision.approveFor(30 * 60_000) });
      try {
        if (failed) s.create.mockRejectedValue(new Error("Grant unavailable"));
        await s.session.send("write");
        expect(s.create).toHaveBeenCalledOnce();
        expect(s.asked[0]!.grantDurations).toEqual([15, 30, 60].map(minutes => minutes * 60_000));
        expect(s.invoke).toHaveBeenCalledOnce();
        const decision = s.session.transcript.find(e => e.type === EntryTypes.approvalDecision)!;
        expect(decision.data["scope"]).toBe(failed ? "once" : "grant");
        expect(s.agent.grants.live).toHaveLength(failed ? 0 : 1);
      } finally { await s.agent.dispose(); }
    }
  });

  it("does not create a grant from an unoffered duration or a rejected approval", async () => {
    const s = await fixture({ marked: false, answer: () => ApprovalDecision.approveFor(120 * 60_000) });
    try {
      await s.session.send("write");
      expect(s.create).not.toHaveBeenCalled();
      expect(s.invoke).toHaveBeenCalledOnce(); // the explicit answer permits this call once only
      expect(s.session.transcript.find(e => e.type === EntryTypes.approvalDecision)?.data["scope"]).toBe("once");
    } finally { await s.agent.dispose(); }
  });
});
