import { describe, expect, it } from "vitest";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, ApprovalPart, immediateScheduler, type TurnLease, type TurnViewModel,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";
import { testServices } from "./services.js";

// The host's gate on running turns (.NET TurnGateTests).

const stamp: FakeModel = r => lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: "stamp" }] };
const says: FakeModel = () => ({ text: "Ok." });

class Lease {
  disposed = 0;
  dispose(): void { this.disposed++; }
}

async function chatWith(model: FakeModel, turnGate?: (signal: AbortSignal) => Promise<TurnLease>) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", contract: [{ name: "stamp", risk: "write" }] }], model });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "stamp", toolClass: "write", run: () => "stamped" })).build();
  const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, ...(turnGate ? { turnGate } : {}) });
  await chat.initialize();
  return { chat, gateway, agent };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(r => setTimeout(r, 5));
  if (!condition()) throw new Error("Timed out.");
}

const pendingCard = (turn: TurnViewModel) => turn.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending);

describe("turnGate", () => {
  it("holds the turn, sends nothing until the gate is released, and releases the lease once", async () => {
    let release!: (lease: TurnLease) => void;
    let entered = false;
    const { chat, gateway } = await chatWith(says, () => { entered = true; return new Promise<TurnLease>(r => { release = r; }); });

    const sending = chat.send("Go.");
    await until(() => entered);
    expect(chat.turns).toHaveLength(1);
    expect([chat.isWaitingForSlot, chat.isBusy, chat.turns[0]!.state]).toEqual([true, true, "running"]);
    await new Promise(r => setTimeout(r, 60));
    expect(gateway.modelCalls).toHaveLength(0);

    const lease = new Lease();
    release(lease);
    await sending;
    expect([chat.isWaitingForSlot, chat.isBusy, chat.turns[0]!.state]).toEqual([false, false, "completed"]);
    expect(gateway.modelCalls).toHaveLength(1);
    expect(lease.disposed).toBe(1);
  });

  it("takes a lease that is a function or a dispose object", async () => {
    let calls = 0;
    const a = await chatWith(says, async () => () => { calls++; });
    await a.chat.send("Go.");
    let disposed = 0;
    const b = await chatWith(says, async () => ({ dispose: () => { disposed++; } }));
    await b.chat.send("Go.");
    expect([calls, disposed]).toEqual([1, 1]);
  });

  it("releases the lease once when the turn fails", async () => {
    const lease = new Lease();
    const { chat } = await chatWith(() => ({ streamError: { message: "broke" } }), async () => lease);
    await chat.send("Go.");
    expect([chat.turns[0]!.state, lease.disposed]).toEqual(["failed", 1]);
  });

  it("releases the lease once when the turn is stopped while it runs", async () => {
    const lease = new Lease();
    const { chat } = await chatWith(stamp, async () => lease);
    const sending = chat.send("Stamp it.");
    await until(() => pendingCard(chat.turns[0]!) !== undefined);
    expect(lease.disposed).toBe(0);
    chat.stop();
    await sending;
    expect([chat.turns[0]!.state, lease.disposed]).toEqual(["stopped", 1]);
  });

  it("Stop while waiting cancels the wait and sends nothing", async () => {
    let entered = false;
    const { chat, gateway } = await chatWith(says, signal => new Promise<TurnLease>((_, reject) => {
      entered = true;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const sending = chat.send("Go.");
    await until(() => entered);
    expect(chat.isWaitingForSlot).toBe(true);
    chat.stop();
    await sending;
    expect([chat.turns[0]!.state, chat.isWaitingForSlot, chat.isBusy, chat.error]).toEqual(["stopped", false, false, undefined]);
    expect(gateway.modelCalls).toHaveLength(0);
  });

  it("a gate that ignores Stop and hands a lease later: nothing is sent and the lease is released", async () => {
    let release!: (lease: TurnLease) => void;
    let entered = false;
    const { chat, gateway } = await chatWith(says, () => { entered = true; return new Promise<TurnLease>(r => { release = r; }); });
    const sending = chat.send("Go.");
    await until(() => entered);
    chat.stop();
    const lease = new Lease();
    release(lease);
    await sending;
    expect([chat.turns[0]!.state, gateway.modelCalls.length, lease.disposed]).toEqual(["stopped", 0, 1]);
  });

  it("a gate that throws fails the turn and sends nothing", async () => {
    const { chat, gateway } = await chatWith(says, () => Promise.reject(new Error("No slots.")));
    await chat.send("Go.");
    expect([chat.turns[0]!.state, chat.turns[0]!.errorMessage, chat.isWaitingForSlot]).toEqual(["failed", "No slots.", false]);
    expect(gateway.modelCalls).toHaveLength(0);
  });

  it("without a gate nothing waits", async () => {
    const { chat, gateway } = await chatWith(says);
    await chat.send("Go.");
    expect([chat.isWaitingForSlot, chat.turns[0]!.state, gateway.modelCalls.length]).toEqual([false, "completed", 1]);
  });

  it("two chats sharing a gate of one run one after the other", async () => {
    const waiting: (() => void)[] = [];
    let free = true;
    const leases: Lease[] = [];
    const gate = (signal: AbortSignal) => new Promise<TurnLease>((resolve, reject) => {
      const take = () => { free = false; const l = new Lease(); leases.push(l); resolve({ dispose: () => { l.dispose(); free = true; waiting.shift()?.(); } }); };
      if (free) take(); else {
        waiting.push(take);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
    });
    const first = await chatWith(stamp, gate), second = await chatWith(says, gate);

    const firstSending = first.chat.send("Stamp it.");
    await until(() => pendingCard(first.chat.turns[0]!) !== undefined);
    const secondSending = second.chat.send("Go.");
    await until(() => second.chat.isWaitingForSlot);
    expect([second.chat.isWaitingForSlot, first.chat.isWaitingForSlot, second.gateway.modelCalls.length]).toEqual([true, false, 0]);

    first.chat.stop();
    await firstSending;
    await secondSending;
    expect([first.chat.turns[0]!.state, second.chat.turns[0]!.state, second.gateway.modelCalls.length]).toEqual(["stopped", "completed", 1]);
    expect(leases.map(l => l.disposed)).toEqual([1, 1]);
    expect(second.chat.isWaitingForSlot).toBe(false);
  });
});
