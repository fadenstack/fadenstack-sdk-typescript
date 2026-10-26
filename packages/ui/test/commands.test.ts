import { describe, expect, it, vi } from "vitest";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { FadenstackClient, loginWithPassword, type AgentPrincipal, type HostToolDecision } from "@fadenstack/client";
import { AgentChatViewModel, ApprovalBroker, ApprovalPart, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";

const principal: AgentPrincipal = { tenantId: "tenant", userId: "user", agentId: "agent", deviceId: "device" };
const decision: HostToolDecision = { decision: "ask", toolClass: "destructive", effectiveToolMode: "auto", requiredByRule: false,
  message: "Individual approval", profileStamp: "a".repeat(64), argumentsStamp: "b".repeat(64), decisionStamp: "c".repeat(64), principal };

async function fixture(options: AgentChatOptions = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "records", version: 1, contract: [{ name: "restore_record", risk: "destructive" }] }] });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "records", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const resource = client.agent!;
  const getProfile = resource.getProfile.bind(resource);
  vi.spyOn(resource, "getProfile").mockImplementation(async (...args) => ({ ...await getProfile(...args), principal }));
  const check = vi.spyOn(resource, "checkHostTool").mockResolvedValue(decision);
  const run = vi.fn((_args: Record<string, unknown>) => "restored");
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "restore_record", toolClass: "destructive", parameters: { type: "object", properties: { action_id: { type: "string" } }, required: ["action_id"], additionalProperties: false }, run })).build();
  const vm = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, ...options });
  await vm.initialize();
  vm.selectToolMode("auto");
  return { vm, agent, gateway, check, run };
}

async function pending(vm: AgentChatViewModel): Promise<ApprovalPart> {
  let card!: ApprovalPart;
  await vi.waitFor(() => {
    card = vm.turns.flatMap(turn => [...turn.parts]).find((part): part is ApprovalPart => part instanceof ApprovalPart && part.isPending)!;
    expect(card).toBeDefined();
  });
  return card;
}

describe("chat explicit commands", () => {
  it("uses shared approval/Stop state without consuming the draft or resolving attachments, and restores as a command", async () => {
    const beforeSend = vi.fn(); const beforeCommand = vi.fn(); const afterCommand = vi.fn();
    const s = await fixture({ beforeSend, beforeCommand, afterCommand });
    s.vm.setInput("Unsent draft");
    const attachment = s.vm.attach({ title: "Unsent source", content: "Not sent to a command", kind: "document" });
    const running = s.vm.invokeTool("restore_record", { action_id: "action-1" }, { origin: "user_history" });
    const card = await pending(s.vm);
    expect(s.vm.isBusy).toBe(true);
    expect(s.run).not.toHaveBeenCalled();
    card.allow();
    expect((await running)?.outcome).toBe("ok");
    expect([s.vm.isBusy, s.vm.input, s.vm.attachments[0]]).toEqual([false, "Unsent draft", attachment]);
    expect(s.gateway.modelCalls).toHaveLength(0);
    expect(beforeSend).not.toHaveBeenCalled();
    expect(beforeCommand).toHaveBeenCalledWith({ name: "restore_record", origin: "user_history" }, expect.any(AbortSignal));
    expect(afterCommand).toHaveBeenCalledOnce();
    expect(s.check).toHaveBeenCalledTimes(2);
    expect(s.vm.turns[0]).toMatchObject({ userText: "restore_record", canRetry: false, canEdit: false });
    const id = s.vm.currentSessionId!;
    s.vm.newChat();
    await s.vm.openSession(id);
    expect(s.vm.turns[0]).toMatchObject({ userText: "restore_record", canRetry: false, canEdit: false });
    expect(s.gateway.modelCalls).toHaveLength(0);
    await s.vm.send("A separate user message");
    expect(s.gateway.modelCalls).toHaveLength(1);
    expect(s.gateway.modelCalls[0]!.messages.some(message => message.role === "tool")).toBe(false);
    s.vm.dispose(); await s.agent.dispose();
  });

  it("Stop during approval cancels the command and a simultaneous send cannot create a model turn", async () => {
    const s = await fixture();
    const running = s.vm.invokeTool("restore_record", { action_id: "action-2" });
    await pending(s.vm);
    await s.vm.send("Must not dispatch while busy");
    s.vm.stop();
    await running;
    expect(s.vm.turns[0]).toMatchObject({ state: "stopped", canRetry: false, canEdit: false });
    expect(s.vm.isBusy).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.gateway.modelCalls).toHaveLength(0);
    s.vm.dispose(); await s.agent.dispose();
  });

  it("host preparation failure preserves the draft and never enters the central/native executor", async () => {
    const afterCommand = vi.fn();
    const s = await fixture({ beforeCommand: () => { throw new Error("Native editor is dirty"); }, afterCommand });
    s.vm.setInput("Keep this");
    expect(await s.vm.invokeTool("restore_record", { action_id: "action-3" })).toBeUndefined();
    expect(s.vm).toMatchObject({ input: "Keep this", error: "Native editor is dirty", isBusy: false });
    expect(s.vm.turns).toHaveLength(0);
    expect(s.check).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
    expect(afterCommand).toHaveBeenCalledOnce();
    s.vm.dispose(); await s.agent.dispose();
  });

  it("copies command arguments before awaiting the host, then rechecks the original payload", async () => {
    let prepared!: () => void;
    const wait = new Promise<void>(resolve => { prepared = resolve; });
    const s = await fixture({ beforeCommand: () => wait });
    const args = { action_id: "original" };
    const running = s.vm.invokeTool("restore_record", args);
    args.action_id = "changed";
    prepared();
    (await pending(s.vm)).allow();
    await running;
    expect(s.run.mock.calls[0]![0]).toEqual({ action_id: "original" });
    expect(s.gateway.modelCalls).toHaveLength(0);
    s.vm.dispose(); await s.agent.dispose();
  });
});
