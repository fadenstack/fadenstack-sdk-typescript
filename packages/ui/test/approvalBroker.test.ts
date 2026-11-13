import { describe, expect, it } from "vitest";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool, type ApprovalRequest } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, ApprovalPart, immediateScheduler, type PendingApproval } from "@fadenstack/ui";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";
import { testServices } from "./services.js";

const request = (sessionId?: string): ApprovalRequest => ({
  ...(sessionId !== undefined ? { sessionId } : {}), callId: "c1", toolName: "write_page", toolClass: "write", source: "host", reason: "", arguments: {},
});

describe("ApprovalBroker routes by session", () => {
  it("hands a request to the chat of its session only, and to every chat when it names none", async () => {
    const broker = new ApprovalBroker();
    const first: PendingApproval[] = [], second: PendingApproval[] = [], watcher: PendingApproval[] = [];
    broker.onRequested(p => first.push(p), () => "s1");
    broker.onRequested(p => second.push(p), () => "s2");
    broker.onRequested(p => watcher.push(p));
    const signal = new AbortController().signal;
    void broker.request(request("s2"), signal);
    expect([first.length, second.length, watcher.length]).toEqual([0, 1, 1]);
    void broker.request(request(), signal);
    expect([first.length, second.length, watcher.length]).toEqual([1, 2, 2]);
  });

  it("declines a request no chat owns", async () => {
    const broker = new ApprovalBroker();
    broker.onRequested(() => undefined, () => "s1");
    const decision = await broker.request(request("elsewhere"), new AbortController().signal);
    expect(decision.approved).toBe(false);
  });

  it("two chats share one broker: the card shows in the chat that asked", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "page", contract: [{ name: "write_page", risk: "write" }] }],
      model: r => lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: "write_page", arguments: { text: "x" } }] },
    });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const broker = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(broker)
      .addTools(defineTool({ name: "write_page", toolClass: "write", run: () => "written" })).build();
    const options = { ...testServices(), scheduler: immediateScheduler };
    const a = new AgentChatViewModel(agent, broker, options), b = new AgentChatViewModel(agent, broker, options);
    await a.initialize();
    await b.initialize();
    try {
      const sending = a.send("write");
      let card: ApprovalPart | undefined;
      for (let i = 0; i < 500 && !card; i++) {
        card = a.turns[0]?.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending);
        if (!card) await new Promise(r => setTimeout(r, 2));
      }
      expect(card).toBeDefined();
      expect(b.turns).toHaveLength(0);
      card!.allow();
      await sending;
      expect(a.turns[0]!.state).toBe("completed");
    } finally { await agent.dispose(); }
  });
});
