import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool, type AgentTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  ApprovalPart,
  builtInStrings,
  immediateScheduler,
  type AgentChatOptions,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";
import { testServices } from "./services.js";

/** A local MCP tool's approval card names its server; a reopened chat's cards say what the tool does (sdk/45 3.3, G4). Port of the .NET McpApprovalTests. */

async function waitFor<T>(find: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** An MCP tool as a tool source would give it: unclassified, from a server on this computer, with the server's own hints. */
function mcpTool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
  return {
    name, parameters: { type: "object", properties: { path: { type: "string" } } }, toolClass: "unknown", source: "mcp", server: "Files",
    invoke: () => "ok", ...extra,
  };
}

/** Runs one call of `tool` and returns the card it asked with (allowed), the chat and the agent. */
async function cardFor(tool: AgentTool, options: Partial<AgentChatOptions> = {}, risk?: string) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", ...(risk ? { contract: [{ name: tool.name, risk: risk as "write" }] } : {}) }],
    model: (r) => (lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: tool.name, arguments: { path: "a" } }] }),
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).addTools(tool).build();
  const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, ...options });
  await vm.initialize();
  const sending = vm.send("Go.");
  const card = await waitFor(() => vm.turns[0]!.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending));
  const request = card.request;
  card.allow();
  await sending;
  return { card, request, vm, agent };
}

describe("the card of a local MCP tool", () => {
  it("names its server and says that the organisation has not checked the tool", async () => {
    const { card } = await cardFor(mcpTool("allowed_folders"));
    expect(card.hasSourceLine).toBe(true);
    expect(card.sourceLine).toBe("From Files, an MCP server on this computer");
    expect(card.reason).toBe("Your organisation has not checked this tool.");
    expect(card.title).toBe("Run allowed_folders?");
  });

  it("adds the server's own hint, the warning first", async () => {
    expect((await cardFor(mcpTool("long_report", { readOnlyHint: true }))).card.reason)
      .toBe("Your organisation has not checked this tool. The server says it only reads.");
    expect((await cardFor(mcpTool("long_report", { destructiveHint: true }))).card.reason)
      .toBe("Your organisation has not checked this tool. The server says it may delete or overwrite.");
    expect((await cardFor(mcpTool("long_report", { readOnlyHint: true, destructiveHint: true }))).card.reason)
      .toBe("Your organisation has not checked this tool. The server says it may delete or overwrite.");
  });

  it("carries the server and the hints on the request, and keeps them when the contract makes the class stricter", async () => {
    const { request } = await cardFor(mcpTool("long_report", { readOnlyHint: true, destructiveHint: false }));
    expect(request).toMatchObject({ source: "mcp", server: "Files", readOnlyHint: true, destructiveHint: false });
    // a contract entry re-classifies the tool (withToolClass): the hints survive it
    const { request: classified } = await cardFor(mcpTool("write_it", { readOnlyHint: true, destructiveHint: false }), {}, "write");
    expect(classified).toMatchObject({ toolClass: "write", server: "Files", readOnlyHint: true, destructiveHint: false });
  });

  it("follows the language", async () => {
    const { card } = await cardFor(mcpTool("allowed_folders", { readOnlyHint: true }), { strings: builtInStrings["de"]! });
    expect(card.sourceLine).toBe("Von Files, einem MCP-Server auf diesem Computer");
    expect(card.reason).toBe("Ihre Organisation hat dieses Tool nicht geprüft. Der Server gibt an, dass es nur liest.");
  });

  it("gives another unclassified tool its own text and no source line", async () => {
    const { card } = await cardFor(defineTool({ name: "do_it", run: () => "ok" }));
    expect(card.hasSourceLine).toBe(false);
    expect(card.sourceLine).toBe("");
    expect(card.reason).toBe("Nobody has said what this tool does.");
    // an MCP tool without a server name has nothing to name either
    const { card: nameless } = await cardFor(mcpTool("x", { server: undefined as unknown as string }));
    expect(nameless.hasSourceLine).toBe(false);
  });

  it("keeps the text of its class for a classified tool, with the source line", async () => {
    const { card } = await cardFor(mcpTool("write_it"), {}, "write");
    expect(card.sourceLine).toBe("From Files, an MCP server on this computer");
    expect(card.reason).toBe(builtInStrings["en"]!.approvalWhy.write);
  });

  it("has the tool's name apart from the words of the title, so the title stands on its own row", async () => {
    const { card } = await cardFor(mcpTool("allowed_folders"));
    expect(card.titleParts).toEqual([{ text: "Run ", code: false }, { text: "allowed_folders", code: true }, { text: "?", code: false }]);
    expect(card.titleParts.map((p) => p.text).join("")).toBe(card.title);
  });
});

describe("a reopened chat's cards", () => {
  async function reopened(tool: AgentTool, risk?: string, options: Partial<AgentChatOptions> = {}) {
    const { vm, agent } = await cardFor(tool, options, risk);
    const again = new AgentChatViewModel(agent, new ApprovalBroker(), { ...testServices(), scheduler: immediateScheduler, ...options });
    await again.initialize();
    await again.openSession(vm.currentSessionId!);
    return again.turns.flatMap((t) => t.parts.filter((p): p is ApprovalPart => p instanceof ApprovalPart));
  }

  it("say what the tool does, not 'Nobody has said what this tool does'", async () => {
    const [card] = await reopened(mcpTool("write_it"), "write");
    expect(card!.request.toolClass).toBe("write");
    expect(card!.classLabel).toBe(builtInStrings["en"]!.approvalClass.write);
    expect(card!.reason).toBe(builtInStrings["en"]!.approvalWhy.write);
  });

  it("keep the class in the card's own entry, not only in the call's start", async () => {
    const { vm, agent } = await cardFor(mcpTool("write_it"), {}, "write");
    const id = vm.currentSessionId!;
    const withoutStarts = new MemorySessionStore();
    for (const e of await agent.sessionStore.read(agent.slug, id)) if (e.type !== "tool.execution_start") await withoutStarts.append(agent.slug, id, e);
    const bare = FadenstackAgent.createBuilder().useClient(agent.client).useSessionStore(withoutStarts).build();
    const again = new AgentChatViewModel(bare, new ApprovalBroker(), { ...testServices(), scheduler: immediateScheduler });
    await again.initialize();
    await again.openSession(id);
    const [card] = again.turns.flatMap((t) => t.parts.filter((p): p is ApprovalPart => p instanceof ApprovalPart));
    expect(card!.request).toMatchObject({ toolClass: "write", server: "Files", source: "mcp" });
    expect(card!.sourceLine).toBe("From Files, an MCP server on this computer");
  });

  it("name a local MCP server's tool's server", async () => {
    const [card] = await reopened(mcpTool("allowed_folders"));
    expect(card!.request).toMatchObject({ source: "mcp", server: "Files", toolClass: "unknown" });
    expect(card!.sourceLine).toBe("From Files, an MCP server on this computer");
  });

  it("take the class from the call's start for an entry written before entries kept it", async () => {
    const { vm, agent } = await cardFor(mcpTool("write_it"), {}, "write");
    // an entry of an older SDK: no tool_class, no server
    const store = agent.sessionStore;
    const id = vm.currentSessionId!;
    const entries = await store.read(agent.slug, id);
    const older = new MemorySessionStore();
    for (const e of entries) {
      const data = { ...e.data };
      if (e.type === "approval.decision") {
        delete data["tool_class"];
        delete data["server"];
      }
      await older.append(agent.slug, id, { ...e, data });
    }
    const legacy = FadenstackAgent.createBuilder().useClient(agent.client).useSessionStore(older).build();
    const again = new AgentChatViewModel(legacy, new ApprovalBroker(), { ...testServices(), scheduler: immediateScheduler });
    await again.initialize();
    await again.openSession(id);
    const [card] = again.turns.flatMap((t) => t.parts.filter((p): p is ApprovalPart => p instanceof ApprovalPart));
    expect(card!.request.toolClass).toBe("write");
    expect(card!.request.server).toBeUndefined();
  });
});
