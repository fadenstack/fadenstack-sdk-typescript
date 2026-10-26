import { describe, expect, it, vi } from "vitest";
import { StageOrder, type HostCommandResult } from "@fadenstack/agents";
import type { AgentPrincipal, HostToolDecision } from "@fadenstack/client";
import { setup } from "./helpers.js";

const principal: AgentPrincipal = { tenantId: "tenant-test", userId: "user-test", agentId: "agent-test", deviceId: "device-test" };
const decision: HostToolDecision = { decision: "ask", toolClass: "destructive", effectiveToolMode: "auto", requiredByRule: false,
  message: "Individual approval", profileStamp: "a".repeat(64), argumentsStamp: "b".repeat(64), decisionStamp: "c".repeat(64), principal };

async function fixture(answer = true, configure?: Parameters<typeof setup>[2]) {
  const s = await setup({}, () => ({ approved: answer }), configure);
  const resource = s.client.agent!;
  const getProfile = resource.getProfile.bind(resource);
  vi.spyOn(resource, "getProfile").mockImplementation(async (...args) => ({ ...await getProfile(...args), principal }));
  const check = vi.spyOn(resource, "checkHostTool").mockResolvedValue(decision);
  const session = await s.agent.startSession("auto");
  return { ...s, session, check };
}

describe("explicit governed host commands", () => {
  it("checks twice, asks individually and runs without a model request", async () => {
    const s = await fixture();
    const result = await s.session.invokeTool("delete_page", { page: 7 }, { origin: "user_history" });
    expect(result.outcome).toBe("ok");
    expect(s.pages.deleted).toEqual([7]);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ canAllowAlways: false, canAllowForSession: false, arguments: { page: 7 } });
    expect(s.check.mock.calls.map(([request]) => request.phase)).toEqual(["prepare", "dispatch"]);
    expect(s.check.mock.calls[0]![0]).toMatchObject({ origin: "user_history", arguments: { page: 7 } });
    expect(s.gateway.requests.some(request => request.path.includes("/chat/completions"))).toBe(false);
    expect(s.session.history).toEqual([]);
  });

  it.each(["off", "read_only"] as const)("refuses a consequential command in %s", async mode => {
    const s = await fixture();
    s.session.toolMode = mode;
    expect((await s.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("denied");
    expect(s.pages.deleted).toEqual([]);
    expect(s.check).not.toHaveBeenCalled();
  });

  it("a central deny and user Deny both produce no native effect", async () => {
    const central = await fixture();
    central.check.mockResolvedValue({ ...decision, decision: "deny" });
    expect((await central.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("denied");
    expect(central.pages.deleted).toEqual([]);
    expect(central.asked).toHaveLength(0);
    const user = await fixture(false);
    expect((await user.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("denied");
    expect(user.pages.deleted).toEqual([]);
    expect(user.check).toHaveBeenCalledOnce();
  });

  it.each(["principal", "profile", "arguments", "decision"] as const)("rejects %s drift while awaiting approval", async kind => {
    const s = await fixture();
    const changed = { ...decision, ...(kind === "principal" ? { principal: { ...principal, userId: "another-user" } }
      : kind === "profile" ? { profileStamp: "d".repeat(64) }
      : kind === "arguments" ? { argumentsStamp: "d".repeat(64) } : { decisionStamp: "d".repeat(64) }) };
    s.check.mockResolvedValueOnce(decision).mockResolvedValueOnce(changed);
    expect((await s.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("error");
    expect(s.pages.deleted).toEqual([]);
  });

  it("refuses a changed authenticated subject before asking", async () => {
    const s = await fixture();
    s.check.mockResolvedValue({ ...decision, principal: { ...principal, userId: "other" } });
    expect((await s.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("error");
    expect(s.asked).toHaveLength(0);
    expect(s.pages.deleted).toEqual([]);
  });

  it("fails closed on an old gateway instead of falling back to a model or direct native call", async () => {
    const s = await fixture();
    s.check.mockRejectedValue(new Error("404: policy endpoint unavailable"));
    expect((await s.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("error");
    expect(s.pages.deleted).toEqual([]);
    expect(s.gateway.requests.some(request => request.path.includes("/chat/completions"))).toBe(false);
  });

  it("does not disclose transformed local arguments through the new check endpoint", async () => {
    const s = await fixture(true, builder => builder.addToolStage(StageOrder.pii, {
      invoke: (call, next) => next({ ...call, arguments: { ...call.arguments, page: 8 } }),
    }));
    expect((await s.session.invokeTool("delete_page", { page: 7 })).outcome).toBe("error");
    expect(s.check).not.toHaveBeenCalled();
    expect(s.pages.deleted).toEqual([]);
  });

  it("Stop during approval cancels the same command signal without dispatch", async () => {
    let requested!: () => void;
    const approval = new Promise<void>(resolve => { requested = resolve; });
    const s = await fixture();
    // Replace the SDK's actual approval handler, not the executor.
    const wait = await setup({}, async () => { requested(); return new Promise(() => {}); });
    const getProfile = wait.client.agent!.getProfile.bind(wait.client.agent!);
    vi.spyOn(wait.client.agent!, "getProfile").mockImplementation(async (...args) => ({ ...await getProfile(...args), principal }));
    const check = vi.spyOn(wait.client.agent!, "checkHostTool").mockResolvedValue(decision);
    const session = await wait.agent.startSession("auto");
    const stop = new AbortController();
    const running: Promise<HostCommandResult> = session.invokeTool("delete_page", { page: 7 }, { signal: stop.signal });
    await approval;
    stop.abort(new Error("user stopped"));
    await expect(running).rejects.toThrow("user stopped");
    expect(check).toHaveBeenCalledOnce();
    expect(wait.pages.deleted).toEqual([]);
    await s.agent.dispose();
  });
});
