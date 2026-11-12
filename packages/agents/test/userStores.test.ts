import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { ApprovalDecision, FadenstackAgent, MemoryApprovalStore, MemorySessionStore, userStoreName } from "@fadenstack/agents";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";

import { PAGE_CONTRACT, Pages } from "./helpers.js";

/** Chats and "Allow always" kept per signed-in user (39 F10; sdk/46 F1). Port of the .NET UserStorageTests. */
describe("stores per signed-in user", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const users = [{ email: "anna@example.com", password: "secret" }, { email: "ben@example.com", password: "secret" }];

  // The model writes a page once, then answers.
  const model: FakeModel = (request) =>
    lastToolResults(request).size ? { text: "Done." } : { toolCalls: [{ id: "c-1", name: "write_page", arguments: { page: 8, text: "x" } }] };

  /** An agent for `email` in the browser profile `gateway` and the stubbed IndexedDB stand for, leaving the stores to the SDK. */
  async function agentFor(gateway: FakeGateway, email: string, configure = (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email, password: "secret", fetch: gateway.fetch }));
    const pages = new Pages();
    return configure(FadenstackAgent.createBuilder().useClient(client).addTools(pages.read, pages.write, pages.delete)
      .useApprovals(() => Promise.resolve(ApprovalDecision.approveAlways()))).build();
  }

  const names = async () => (await indexedDB.databases()).map((d) => d.name).sort();

  it("keeps sessions and what was allowed always in the user's own database", async () => {
    const gateway = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const anna = await agentFor(gateway, "anna@example.com");
    await (await anna.startSession("ask")).send("write");
    await anna.dispose();

    expect(await names()).toEqual(["fadenstack-approvals:tenant-1:user-1", "fadenstack-sessions:tenant-1:user-1"]);
  });

  it("never lets two people in one browser profile see each other's chats or what they allowed always", async () => {
    // 39 F10: "always" was keyed by the agent's slug alone, for every Fadenstack user of the browser profile.
    const gateway = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const anna = await agentFor(gateway, "anna@example.com");
    await (await anna.startSession("ask")).send("write");
    expect([(await anna.listSessions()).length, (await anna.listApprovals()).length]).toEqual([1, 1]);
    await anna.dispose();

    const ben = await agentFor(gateway, "ben@example.com");
    await ben.start();
    expect(await ben.listApprovals()).toEqual([]);
    expect(await ben.listSessions()).toEqual([]);
    await (await ben.startSession("ask")).send("write");
    await ben.dispose();

    // Anna comes back, with a new agent: hers are still hers, and Ben's reset leaves them alone.
    const again = await agentFor(gateway, "anna@example.com");
    expect([(await again.listSessions()).length, (await again.listApprovals()).length]).toEqual([1, 1]);
    const bensAgain = await agentFor(gateway, "ben@example.com");
    await bensAgain.resetApprovals();
    expect(await bensAgain.listApprovals()).toEqual([]);
    expect(await again.listApprovals()).toMatchObject([{ tool: "write_page", toolClass: "write" }]);
    await again.dispose();
    await bensAgain.dispose();
  });

  it("stays in the shared databases of an older SDK from a gateway that names no user, and moves nothing to a user", async () => {
    const gateway = new FakeGateway({ users, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const old = await agentFor(gateway, "anna@example.com");
    await (await old.startSession("ask")).send("write");
    await old.dispose();
    expect(await names()).toEqual(["fadenstack-approvals", "fadenstack-sessions"]);

    // The same browser profile, now against a gateway that names its users: nobody inherits what was kept before.
    const named = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const ben = await agentFor(named, "ben@example.com");
    await ben.start();
    expect([await ben.listSessions(), await ben.listApprovals()]).toEqual([[], []]);
    await ben.dispose();
  });

  it("uses a store the host passed as it is, and needs no start for it", async () => {
    const gateway = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const sessions = new MemorySessionStore(), approvals = new MemoryApprovalStore();
    const agent = await agentFor(gateway, "anna@example.com", (b) => b.useSessionStore(sessions).useApprovalStore(approvals));

    expect(await agent.listSessions()).toEqual([]); // not started, and no profile read for it
    expect(gateway.requests.some((r) => r.path.endsWith("/profile"))).toBe(false);
    await (await agent.startSession("ask")).send("write");

    expect(agent.sessionStore).toBe(sessions);
    expect(agent.approvalStore).toBe(approvals);
    expect(await names()).toEqual([]);
    expect(await agent.listApprovals()).toHaveLength(1);
  });

  it("starts the agent first to list or reset what it keeps itself", async () => {
    const gateway = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const agent = await agentFor(gateway, "anna@example.com");

    expect(await agent.listApprovals()).toEqual([]);
    expect(agent.isStarted).toBe(true);
    await agent.resetApprovals("write_page"); // nothing to forget, nothing thrown
    await agent.dispose();
  });

  it("falls back to memory where there is no IndexedDB", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("indexedDB", undefined);
    const gateway = new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const agent = await agentFor(gateway, "anna@example.com");
    await (await agent.startSession("ask")).send("write");
    expect([(await agent.listSessions()).length, (await agent.listApprovals()).length]).toEqual([1, 1]);
  });

  it("names a user's database so that no two users share one", () => {
    const name = (tenantId: string, userId: string) => userStoreName("fadenstack-sessions", { tenantId, userId });
    expect(userStoreName("fadenstack-sessions", undefined)).toBe("fadenstack-sessions");
    expect(new Set([name("a.b", "c"), name("a", "b.c"), name("a:b", "c"), name("a", "b:c"), name("a", "bc"), name("ab", "c")]).size).toBe(6);
  });
});
