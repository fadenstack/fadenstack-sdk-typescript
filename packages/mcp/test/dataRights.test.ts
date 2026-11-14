import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { ApprovalDecision, FadenstackAgent, MemoryApprovalStore, MemorySessionStore } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";
import { mcpModule, type McpModule } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";

const SECRET = "Bearer s3cret-token-value-0123456789";

/** sdk/51 F05: the person's servers go with the rest of their data on this device (`deleteMyData`), as the skills database does. */
describe("the person's MCP servers and their data", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const users = [{ email: "anna@example.com", password: "secret" }, { email: "ben@example.com", password: "secret" }];
  const names = async () => (await indexedDB.databases()).map((d) => d.name).sort();
  const mcpNames = async () => (await names()).filter((n) => n?.startsWith("fadenstack-mcp:"));

  async function agentFor(gateway: FakeGateway, email: string, module: McpModule): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email, password: "secret", fetch: gateway.fetch }));
    return FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
      .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).use(module).build();
  }

  it("removes the user's database and, with their key, every header sealed in it; another user's stays", async () => {
    const fake = new FakeMcpServer();
    const gateway = new FakeGateway({ users, principal: true, model: () => ({ text: "Hi." }), agents: [{ slug: "docs", localMcpMode: "allow" }] });
    const options = { fetch: fake.fetch as typeof fetch };
    const bens = mcpModule(options);
    const ben = await agentFor(gateway, "ben@example.com", bens);
    await (await ben.startSession()).send("Hi");
    await bens.add({ label: "bens", url: fake.urls.both, headers: { Authorization: SECRET } });
    await ben.dispose();

    const annas = mcpModule(options);
    const anna = await agentFor(gateway, "anna@example.com", annas);
    await (await anna.startSession()).send("Hi"); // the module learns the principal here
    await annas.add({ label: "annas", url: fake.urls.both, headers: { Authorization: SECRET }, enabled: true });
    expect(await mcpNames()).toHaveLength(2);
    await (await anna.startSession()).send("Again");
    expect(annas.statuses[0]).toMatchObject({ label: "annas", state: "running" });

    const result = await anna.deleteMyData();

    expect(result.storesCleared).toBe(2); // her key and her servers (the sessions and approvals here are the host's own, in memory)
    expect(await mcpNames()).toEqual(["fadenstack-mcp:tenant-1:user-2"]); // Ben's is left
    expect((await names()).filter((n) => n?.startsWith("fadenstack-keys:"))).toEqual(["fadenstack-keys:tenant-1:user-2"]);
    expect(await annas.servers()).toEqual([]); // and goes on: a new, empty list
    await anna.dispose();

    const again = mcpModule(options);
    const bensAgain = await agentFor(gateway, "ben@example.com", again);
    await (await bensAgain.startSession()).send("Hi");
    expect((await again.servers()).map((s) => [s.label, s.headers])).toEqual([["bens", { Authorization: SECRET }]]); // Ben's headers still open with Ben's key
    await bensAgain.dispose();
  });
});
