import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  ToolsViewModel,
  englishStrings,
  germanStrings,
  immediateScheduler,
  serverToolStatus,
  type AgentChatOptions,
} from "@fadenstack/ui";
import { FakeGateway, type FakeAgent } from "@fadenstack/testing";
import { testServices } from "./services.js";

async function chat(agent: Partial<FakeAgent> = {}, options: Partial<AgentChatOptions> = {}, fetchFor?: (gateway: FakeGateway) => typeof fetch) {
  const gateway = new FakeGateway({
    agents: [{
      slug: "page", name: "Page assistant",
      contract: [{ name: "read_page", risk: "read" }, { name: "fill_field", risk: "write" }, { name: "delete_page", risk: "destructive" }],
      ...agent,
    }],
  });
  const fetchImpl = fetchFor ? fetchFor(gateway) : gateway.fetch;
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: fetchImpl });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(
      defineTool({ name: "read_page", description: "Reads the page", toolClass: "read", run: () => "x" }),
      defineTool({ name: "fill_field", description: "Fills a field", toolClass: "write", run: () => "x" }),
      defineTool({ name: "delete_page", toolClass: "destructive", run: () => "x" }),
    ).build();
  const vm = new AgentChatViewModel(built, approvals, {
    ...testServices(), scheduler: immediateScheduler, locale: "en-GB", ...options,
  });
  await vm.initialize();
  return { chat: vm, gateway };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("serverToolStatus", () => {
  it("is available when allowed and enabled; an administrator's switch-off is named before the agent's rules", () => {
    expect(serverToolStatus({ allowed: true, enabled: true })).toBe("available");
    expect(serverToolStatus({ allowed: true, enabled: false })).toBe("disabled");
    expect(serverToolStatus({ allowed: false, enabled: true })).toBe("not_allowed");
    expect(serverToolStatus({ allowed: false, enabled: false })).toBe("disabled");
  });
});

describe("chat.tools", () => {
  const serverTools = [
    { name: "mcp.github.search", server: "github", description: "Searches <b>issues</b>\nand pull requests", allowed: true, enabled: true },
    { name: "mcp.github.merge", server: "github", description: "Merges", allowed: false, enabled: true },
    { name: "mcp.wiki.read", server: "wiki", description: "x".repeat(1000), allowed: true, enabled: false },
  ];

  it("lists the app's tools with their class, and loads the server's list only when opened", async () => {
    const { chat: vm, gateway } = await chat({ serverTools });
    expect(gateway.requests.some((r) => r.path.endsWith("/tools"))).toBe(false);
    expect(vm.tools.hostTools.map((t) => [t.name, t.toolClass, t.classLabel, t.description])).toEqual([
      ["read_page", "read", "Read", "Reads the page"],
      ["fill_field", "write", "Changes data", "Fills a field"],
      ["delete_page", "destructive", "Cannot be undone", ""],
    ]);
    vm.setToolsOpen(true);
    expect(vm.isToolsOpen).toBe(true);
    expect(vm.tools.isLoading).toBe(true);
    await until(() => vm.tools.state === "ready");
    expect(gateway.requests.filter((r) => r.path.endsWith("/tools")).length).toBe(1);
  });

  it("groups the server's tools by MCP server, each with its translated status; descriptions are plain, one line, and clamped", async () => {
    const { chat: vm } = await chat({ serverTools });
    vm.setToolsOpen(true);
    await until(() => vm.tools.state === "ready");
    const groups = vm.tools.serverGroups;
    expect(groups.map((g) => g.server)).toEqual(["github", "wiki"]);
    expect(groups[0]!.tools.map((t) => [t.name, t.status, t.statusLabel])).toEqual([
      ["mcp.github.search", "available", "Available to this agent"],
      ["mcp.github.merge", "not_allowed", "Not allowed for this agent"],
    ]);
    expect(groups[0]!.tools[0]!.description).toBe("Searches <b>issues</b> and pull requests"); // text, for the skin to draw as text
    expect(groups[1]!.tools[0]!.status).toBe("disabled");
    expect(groups[1]!.tools[0]!.statusLabel).toBe("Switched off by your administrator");
    expect(Array.from(groups[1]!.tools[0]!.description).length).toBe(300);
    expect(groups[1]!.tools[0]!.description.endsWith("…")).toBe(true);
    expect(vm.tools.isServerEmpty).toBe(false);
  });

  it("says so in German with Sie", async () => {
    const { chat: vm } = await chat({ serverTools }, { automaticLanguage: "de" });
    vm.setToolsOpen(true);
    await until(() => vm.tools.state === "ready");
    expect(vm.tools.serverGroups[0]!.tools[1]!.statusLabel).toBe("Für diesen Agenten nicht erlaubt");
    expect(vm.tools.hostTools[1]!.classLabel).toBe("Ändert Daten");
    expect(germanStrings.toolStatusDisabled).toBe("Von Ihrer Administration ausgeschaltet");
    expect(englishStrings.toolsFailed).toBe("The tools could not be listed right now");
  });

  it("shows the empty state, not an error, for a server with no such route (404) and for an empty list", async () => {
    const old = await chat({});
    old.chat.setToolsOpen(true);
    await until(() => old.chat.tools.state === "ready");
    expect(old.chat.tools.failed).toBe(false);
    expect(old.chat.tools.isServerEmpty).toBe(true);
    expect(old.chat.tools.serverGroups).toEqual([]);

    const empty = await chat({ serverTools: [] });
    empty.chat.setToolsOpen(true);
    await until(() => empty.chat.tools.state === "ready");
    expect(empty.chat.tools.isServerEmpty).toBe(true);
  });

  it("fails with a state of its own when the list cannot be read, and reads it again on request", async () => {
    let fail = true;
    const { chat: vm } = await chat({ serverTools }, {}, (gateway) => ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (fail && url.endsWith("/tools")) return Promise.resolve(new Response(JSON.stringify({ detail: "no" }), { status: 403, headers: { "content-type": "application/json" } }));
      return gateway.fetch(input, init);
    }) as typeof fetch);
    vm.setToolsOpen(true);
    await until(() => vm.tools.state === "failed");
    expect(vm.tools.failed).toBe(true);
    expect(vm.tools.isServerEmpty).toBe(false);
    fail = false;
    await vm.tools.load();
    expect(vm.tools.state).toBe("ready");
    expect(vm.tools.serverGroups.length).toBe(2);
  });

  it("opens like About: it closes the settings and About, and they close it", async () => {
    const { chat: vm } = await chat({ serverTools });
    vm.setSettingsOpen(true);
    vm.setToolsOpen(true);
    expect(vm.isSettingsOpen).toBe(false);
    expect(vm.isToolsOpen).toBe(true);
    vm.setAboutOpen(true);
    expect(vm.isToolsOpen).toBe(false);
    expect(vm.isAboutOpen).toBe(true);
    vm.setToolsOpen(true);
    expect(vm.isAboutOpen).toBe(false);
    vm.setSettingsOpen(true);
    expect(vm.isToolsOpen).toBe(false);
    vm.setToolsOpen(true);
    vm.setToolsOpen(false);
    expect(vm.isToolsOpen).toBe(false);
  });

  it("has no switches: nothing in the view model changes a tool", async () => {
    const { chat: vm } = await chat({ serverTools });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(vm.tools)).filter((n) => /^(set|toggle|enable|disable|switch)/i.test(n))).toEqual([]);
  });
});

describe("ToolsViewModel on its own", () => {
  const strings = () => englishStrings;

  it("leaves the server's own gateway tools out of 'In this app', and names an unnamed server", async () => {
    const vm = new ToolsViewModel({
      hostTools: () => [{ name: "a", toolClass: "read", source: "host" }, { name: "b", toolClass: "read", source: "gateway" }],
      load: () => Promise.resolve([{ name: "t", server: "", description: "", allowed: true, enabled: true }]),
      strings,
    });
    expect(vm.hostTools.map((t) => t.name)).toEqual(["a"]);
    await vm.load();
    expect(vm.serverGroups[0]!.server).toBe("Server tool");
  });

  it("stops a read when the view closes: the late answer changes nothing", async () => {
    let release!: (list: []) => void;
    const vm = new ToolsViewModel({ hostTools: () => [], load: () => new Promise((r) => { release = r; }), strings });
    const loading = vm.load();
    expect(vm.state).toBe("loading");
    vm.cancel();
    expect(vm.state).toBe("idle");
    release([]);
    await loading;
    expect(vm.state).toBe("idle");
  });
});
