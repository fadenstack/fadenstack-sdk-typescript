import { describe, expect, it, vi } from "vitest";
import {
  ApprovalDecision, FadenstackAgent, OnRequestTools, RESERVED_TOOL_NAMES, defineTool, isChangingToolSource,
  type AgentTool, type ApprovalRequest, type ChangingToolSource,
} from "@fadenstack/agents";
import { HOST_TOOL_DISPATCH_FEATURE, type LogEvent } from "@fadenstack/client";
// The core mark is package-internal; the tests run against the sources, so this is the same symbol the agent checks.
import { CORE_TOOL_SOURCE } from "../src/tools.js";
import type { FakeGatewayOptions, FakeReply } from "@fadenstack/testing";
import { setup } from "./helpers.js";

// Tool sources that change between turns, and tools on request (.NET ChangingToolSourceTests, LocalMcpOnRequestTests).

const tool = (name: string, description = "A test tool."): AgentTool =>
  ({ ...defineTool({ name, description, toolClass: "read", run: () => `${name} ran` }), source: "mcp" });

/** A source whose tools the test sets; every ask is counted. */
class Source implements ChangingToolSource {
  asked = 0;
  fails = false;
  #tools: AgentTool[];
  readonly #listeners = new Set<() => void>();
  constructor(...names: string[]) { this.#tools = names.map((n) => tool(n)); }
  async getTools(): Promise<readonly AgentTool[]> {
    this.asked++;
    if (this.fails && this.asked > 1) throw new Error("the source is down");
    return this.#tools;
  }
  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  set(...names: string[]): void { this.#tools = names.map((n) => tool(n)); this.raise(); }
  get listening(): number { return this.#listeners.size; }
  raise(): void { for (const l of [...this.#listeners]) l(); }
}

/** A plain source: no change event. */
const fixed = (t: AgentTool) => ({ getTools: async () => [t] });

const script = (...replies: FakeReply[]): Pick<FakeGatewayOptions, "model"> => {
  const queue = [...replies];
  return { model: () => queue.shift() ?? { text: "Done." } };
};
const call = (name: string, args: Record<string, unknown> = {}): FakeReply => ({ toolCalls: [{ id: `c-${name}`, name, arguments: args }] });
const hasToolMessage = (m: { role: string }) => m.role === "tool";

// The gateway holds back tools outside a non-empty contract (local tools need the agent's permission): an agent with no
// contract, for the sources' own tools; the page tools of `setup` are left out of what the model is shown.
const OPEN = { agents: [{ slug: "docs", contract: [] }] };
const PAGE = new Set(["read_page", "write_page", "delete_page"]);

async function boot(options: FakeGatewayOptions, ...sources: unknown[]) {
  return setup({ ...(options.agents ? {} : OPEN), ...options }, () => ApprovalDecision.approve(), (b) => {
    for (const s of sources) b.addToolSource(s as never);
    return b;
  });
}

const toolNames = (s: Awaited<ReturnType<typeof boot>>, request: number) =>
  s.gateway.modelCalls[request]!.tools.map((t) => t.name).filter((n) => !PAGE.has(n));
const lastResult = (s: Awaited<ReturnType<typeof boot>>, request: number) =>
  s.gateway.modelCalls[request]!.messages.filter(hasToolMessage).at(-1)!.content as string;

describe("a tool source that changes", () => {
  it("isChangingToolSource tells a source with a change event", () => {
    expect(isChangingToolSource(new Source())).toBe(true);
    expect(isChangingToolSource({ getTools: async () => [] })).toBe(false);
  });

  it("shows in the second turn's tools, not before the next turn starts", async () => {
    const source = new Source("alpha");
    const s = await boot(script({ text: "One." }, { text: "Two." }), source);
    try {
      const session = await s.agent.startSession();
      await session.send("first");
      source.set("alpha", "beta");
      expect(s.agent.tools.map((t) => t.name).filter((n) => !PAGE.has(n))).toEqual(["alpha"]);
      await session.send("second");
      expect(toolNames(s, 0)).toEqual(["alpha"]);
      expect(toolNames(s, 1)).toEqual(["alpha", "beta"]);
      expect(s.agent.tools.map((t) => t.name).filter((n) => !PAGE.has(n))).toEqual(["alpha", "beta"]);
      expect(source.asked).toBe(2); // once at start, once after the change
    } finally { await s.agent.dispose(); }
  });

  it("is not asked again while it says nothing", async () => {
    const source = new Source("alpha");
    const s = await boot({}, source);
    try {
      const session = await s.agent.startSession();
      for (const text of ["a", "b", "c"]) await session.send(text);
      expect(source.asked).toBe(1);
    } finally { await s.agent.dispose(); }
  });

  it("changed inside a turn waits for the next turn", async () => {
    const source = new Source("alpha");
    const flip: AgentTool = { ...defineTool({ name: "flip", toolClass: "read", run: () => { source.set("alpha", "beta"); return "changed"; } }), source: "mcp" };
    const s = await boot(script(call("flip"), { text: "Done." }, { text: "Next." }), source, fixed(flip));
    try {
      const session = await s.agent.startSession();
      await session.send("flip it");
      await session.send("again");
      expect(toolNames(s, 0)).toEqual(["alpha", "flip"]);
      expect(toolNames(s, 1)).toEqual(["alpha", "flip"]); // the same turn, after the change: unchanged
      expect(toolNames(s, 2)).toEqual(["alpha", "beta", "flip"]);
    } finally { await s.agent.dispose(); }
  });

  it("a tool that went away is refused as no longer available", async () => {
    const source = new Source("alpha", "beta");
    const s = await boot(script({ text: "One." }, call("beta"), { text: "Gone." }), source);
    try {
      const session = await s.agent.startSession();
      await session.send("first");
      source.set("alpha");
      await session.send("second");
      expect(lastResult(s, 2)).toBe("beta is no longer available.");
    } finally { await s.agent.dispose(); }
  });

  it("a name that was never offered is still unknown", async () => {
    const s = await boot(script(call("made_up"), { text: "No." }), new Source("alpha"));
    try {
      await (await s.agent.startSession()).send("go");
      expect(lastResult(s, 1)).toBe("Tool 'made_up' does not exist here.");
    } finally { await s.agent.dispose(); }
  });

  it("a source that fails when asked again keeps its tools", async () => {
    const source = new Source("alpha");
    source.fails = true;
    const s = await boot({}, source);
    try {
      const session = await s.agent.startSession();
      await session.send("first");
      source.raise();
      await session.send("second");
      expect(toolNames(s, 1)).toEqual(["alpha"]);
    } finally { await s.agent.dispose(); }
  });

  it("many changes settle on the newest list, and the agent stops listening when disposed", async () => {
    const source = new Source("alpha");
    const s = await boot({}, source);
    const session = await s.agent.startSession();
    await session.send("first");
    for (let i = 0; i < 200; i++) source.raise();
    source.set("alpha", "beta", "gamma");
    await Promise.all(Array.from({ length: 20 }, async () => source.raise()));
    await session.send("second");
    expect(toolNames(s, 1)).toEqual(["alpha", "beta", "gamma"]);
    expect(source.listening).toBe(1);
    await s.agent.dispose();
    expect(source.listening).toBe(0); // the agent stopped listening
  });

  it("a host tool still wins over a source tool of the same name", async () => {
    const s = await boot({}, new Source("read_page"));
    try {
      await s.agent.start();
      expect(s.agent.tools.find((t) => t.name === "read_page")!.source).toBe("host");
    } finally { await s.agent.dispose(); }
  });
});

// -- tools on request ---------------------------------------------------------------------------------------------

const names = ["search_issues", "create_issue", "get_file", "list_branches", "merge_pull_request"];
const github = (ran: string[] = []): AgentTool[] => [
  defineTool<{ query?: string }>({ name: "search_issues", description: "Searches the issues of a repository.", toolClass: "read", run: (a) => { ran.push(`search ${a.query ?? ""}`); return "3 issues"; } }),
  defineTool({ name: "create_issue", description: "Creates a new issue in a repository.", toolClass: "write", run: () => { ran.push("create"); return "created #7"; } }),
  defineTool({ name: "get_file", description: "Reads a file from a repository.", toolClass: "read", run: () => "contents" }),
  defineTool({ name: "list_branches", description: "Lists the branches of a repository.", toolClass: "read", run: () => "main, dev" }),
  defineTool({ name: "merge_pull_request", description: "Merges a pull request.", toolClass: "destructive", run: () => "merged" }),
];
const contractFor = (tools: readonly string[], risk: "read" | "write" | "destructive" = "read") => tools.map((name) => ({ name, risk }));
const classOf = (name: string): "read" | "write" | "destructive" => name === "create_issue" ? "write" : name === "merge_pull_request" ? "destructive" : "read";
const onRequestOptions = (model: FakeGatewayOptions["model"], extra: string[] = []): FakeGatewayOptions => ({
  agents: [{ slug: "docs", contract: [...names, "find_tool", ...extra].map((name) => ({ name, risk: classOf(name) })) }], ...(model ? { model } : {}),
});

describe("tools on request", () => {
  it("offers no on-request tool before find_tool, and find_tool carries the index in the same bytes every turn", async () => {
    const source = new OnRequestTools(github(), { index: ["github: Works with repositories, issues and pull requests."] });
    const s = await boot(onRequestOptions(undefined), source);
    try {
      const session = await s.agent.startSession("auto");
      await session.send("Hello");
      await session.send("Hello again");
      const find = (i: number) => s.gateway.modelCalls[i]!.tools.find((t) => t.name === "find_tool")!;
      expect(toolNames(s, 0)).toEqual(["find_tool"]);
      expect(find(0).description).toMatch(/^Finds tools that are switched off/);
      expect(find(0).description).toMatch(/Tools on request:\ngithub: Works with repositories, issues and pull requests\.$/);
      expect(find(0).parameters!.required).toEqual(["query"]);
      expect(JSON.stringify(find(1))).toBe(JSON.stringify(find(0))); // the model's cache holds
      expect(s.agent.tools.find((t) => t.name === "find_tool")!.toolClass).toBe("read");
    } finally { await s.agent.dispose(); }
  });

  it("a search switches on the best matches and the next step carries their schemas", async () => {
    const ran: string[] = [];
    const s = await boot(onRequestOptions(script(call("find_tool", { query: "issues" }), call("search_issues", { query: "bug" }), { text: "Found." }).model),
      new OnRequestTools(github(ran)));
    try {
      const session = await s.agent.startSession("auto");
      await session.send("find the bug");
      expect(toolNames(s, 0)).toEqual(["find_tool"]);
      expect(toolNames(s, 1)).toEqual(expect.arrayContaining(["find_tool", "search_issues", "create_issue"]));
      expect(toolNames(s, 1)).not.toContain("merge_pull_request");
      expect(lastResult(s, 1)).toMatch(/^Switched on 2 tools for this conversation\. Call them with their parameters\.\n(.*\n)?search_issues: Searches the issues/);
      expect(ran).toEqual(["search bug"]);
    } finally { await s.agent.dispose(); }
  });

  it("a search switches on five at most, and says when nothing matches", async () => {
    const many = Array.from({ length: 8 }, (_, i) => defineTool({ name: `repo_tool_${i}`, description: "Works on a repository.", toolClass: "read", run: () => "ok" }));
    const s = await boot({ agents: [{ slug: "docs", contract: contractFor(["find_tool", ...many.map((t) => t.name)]) }],
      ...script(call("find_tool", { query: "repository" }), call("find_tool", { query: "zebra" }), { text: "Done." }) }, new OnRequestTools(many));
    try {
      await (await s.agent.startSession("auto")).send("go");
      expect(toolNames(s, 1)).toHaveLength(1 + 5);
      expect(lastResult(s, 2)).toBe("No tool matched that search. Try other words.");
    } finally { await s.agent.dispose(); }
  });

  it("a tool called by name is switched on, not run and not asked about", async () => {
    const ran: string[] = [];
    const asked: ApprovalRequest[] = [];
    const s = await setup(onRequestOptions(script(call("create_issue"), call("create_issue"), { text: "Done." }).model),
      (r) => { asked.push(r); return ApprovalDecision.approve(); }, (b) => b.addToolSource(new OnRequestTools(github(ran))));
    try {
      const session = await s.agent.startSession("ask");
      await session.send("make an issue");
      expect(lastResult(s, 1)).toBe("create_issue is now switched on. Call it again with its parameters.");
      expect(ran).toEqual(["create"]); // the second call ran it, after the person was asked once
      expect(asked.map((r) => r.toolName)).toEqual(["create_issue"]);
    } finally { await s.agent.dispose(); }
  });

  it("what is switched on belongs to one conversation", async () => {
    const s = await boot(onRequestOptions(script(call("find_tool", { query: "branches" }), { text: "Found." }, { text: "Other." }).model), new OnRequestTools(github()));
    try {
      const a = await s.agent.startSession("auto");
      await a.send("branches");
      expect(toolNames(s, 1)).toContain("list_branches");
      const b = await s.agent.startSession("auto");
      await b.send("something else");
      expect(toolNames(s, 2)).toEqual(["find_tool"]);
    } finally { await s.agent.dispose(); }
  });

  it("at most ten are in scope, and a new pick pushes out the least recently used", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => defineTool({ name: `tool_${String(i).padStart(2, "0")}`, description: `Does job ${String.fromCharCode(97 + i)}alpha.`, toolClass: "read", run: () => "ok" }));
    const queries = twelve.map((t, i) => call("find_tool", { query: `${String.fromCharCode(97 + i)}alpha` }));
    const s = await boot({ agents: [{ slug: "docs", contract: contractFor(["find_tool", ...twelve.map((t) => t.name)]) }], ...script(...queries, { text: "Done." }) }, new OnRequestTools(twelve));
    try {
      await (await s.agent.startSession("auto")).send("go");
      const last = toolNames(s, 12);
      expect(last).toContain("find_tool");
      expect(last.filter((n) => n.startsWith("tool_"))).toHaveLength(10);
      expect(last).not.toContain("tool_00"); // the first pick is the least recently used
      expect(last).toContain("tool_11");
    } finally { await s.agent.dispose(); }
  });

  it("a read-only turn gets find_tool but no tool the contract does not vouch for as a read", async () => {
    const s = await boot(onRequestOptions(script(call("find_tool", { query: "issues" }), { text: "Done." }).model), new OnRequestTools(github()));
    try {
      await (await s.agent.startSession("read_only")).send("go");
      expect(toolNames(s, 0)).toEqual(["find_tool"]);
      expect(toolNames(s, 1)).toEqual(["find_tool", "search_issues"]); // create_issue is a write: hidden in read-only
    } finally { await s.agent.dispose(); }
  });

  it("a tool whose definition changed must be found again", async () => {
    const source = new OnRequestTools(github());
    const s = await boot(onRequestOptions(script(call("find_tool", { query: "branches" }), { text: "Found." }, call("list_branches"), { text: "Again." }).model), source);
    try {
      const session = await s.agent.startSession("auto");
      await session.send("branches");
      source.set(github()); // the same names, new definitions
      await session.send("list them");
      expect(toolNames(s, 2)).toEqual(["find_tool"]); // not offered until found again
      expect(lastResult(s, 3)).toBe("list_branches is now switched on. Call it again with its parameters.");
    } finally { await s.agent.dispose(); }
  });

  it("a new tool the host adds can be found at the next turn", async () => {
    const source = new OnRequestTools(github().slice(0, 1));
    const s = await boot(onRequestOptions(script({ text: "One." }, call("find_tool", { query: "branches" }), { text: "Found." }).model), source);
    try {
      const session = await s.agent.startSession("auto");
      await session.send("first");
      source.set(github());
      await session.send("branches please");
      expect(toolNames(s, 2)).toContain("list_branches");
    } finally { await s.agent.dispose(); }
  });

  it("the app manifest reports the tools on request and find_tool, so the server can learn of them", async () => {
    const s = await boot({}, new OnRequestTools(github()));
    try {
      await s.agent.start();
      for (let i = 0; i < 100 && s.gateway.manifests.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      const reported = (s.gateway.manifests[0]!.manifest["tools"] as { name: string }[]).map((t) => t.name);
      expect(reported).toEqual(expect.arrayContaining(["find_tool", ...names]));
    } finally { await s.agent.dispose(); }
  });

  it("find_tool is the SDK's: read and offered under a contract that does not list it, and it never asks", async () => {
    const asked: string[] = [];
    const s = await setup({ agents: [{ slug: "docs", contract: [{ name: "get_file", risk: "read" }] }],
      ...script(call("find_tool", { query: "files" }), { text: "Done." }) },
      (request: ApprovalRequest) => { asked.push(request.toolName); return ApprovalDecision.approve(); },
      (b) => b.addToolSource(new OnRequestTools(github())));
    try {
      await (await s.agent.startSession("ask")).send("go");
      expect(toolNames(s, 0)).toEqual(["find_tool"]);
      expect(toolNames(s, 1)).toEqual(["find_tool", "get_file"]); // the tools it finds still follow the contract
      expect(s.agent.tools.find((t) => t.name === "find_tool")?.toolClass).toBe("read");
      expect(asked).toEqual([]);
    } finally { await s.agent.dispose(); }
  });

  it("find_tool needs no server check per call: it runs nothing outside", async () => {
    const s = await setup({ ...OPEN, ...script(call("find_tool", { query: "files" }), { text: "Done." }) },
      () => ApprovalDecision.approve(), (b) => b.addToolSource(new OnRequestTools(github())));
    try {
      // The server advertises the per-call check (as hostPolicy.test.ts plays it): host tools are checked, find_tool not.
      const resource = s.client.agent!;
      const original = resource.getProfile.bind(resource);
      vi.spyOn(resource, "getProfile").mockImplementation(async (signal) => {
        const p = await original(signal);
        return { ...p, principal: { tenantId: "t", userId: "u", agentId: "a", deviceId: "d" },
          features: [...p.features, HOST_TOOL_DISPATCH_FEATURE] };
      });
      const check = vi.spyOn(resource, "checkHostTool");
      await (await s.agent.startSession("auto")).send("go");
      expect(s.agent.hostToolPolicyChecks).toBe(true);
      expect(check).not.toHaveBeenCalled();
      expect(lastResult(s, 1)).toContain("get_file"); // the search ran and listed what it switched on
    } finally { await s.agent.dispose(); }
  });

  it("the SDK keeps five names", () => {
    expect(RESERVED_TOOL_NAMES).toEqual(["find_tool", "load_skill", "read_skill_resource", "run_skill_script", "web_search"]);
    expect(Object.isFrozen(RESERVED_TOOL_NAMES)).toBe(true);
  });

  for (const name of ["find_tool", "load_skill", "read_skill_resource", "run_skill_script", "web_search"]) {
    it(`an app's tool cannot take the name ${name}, by addTools, a module or the tools on request`, () => {
      const own = defineTool({ name, description: "Deletes what it finds.", toolClass: "destructive", run: () => "deleted" });
      expect(() => FadenstackAgent.createBuilder().addTools(own)).toThrow(new RegExp(`'${name}' is a name the SDK keeps for its own tools`));
      expect(() => FadenstackAgent.createBuilder().use({ configure: (b) => { b.addTools(own); } })).toThrow(TypeError);
      expect(() => new OnRequestTools([tool("get_file"), own])).toThrow(TypeError);
      expect(() => new OnRequestTools([tool("get_file")]).set([own])).toThrow(TypeError);
    });

    it(`an app's source that brings ${name} has it left out, and it is logged; the SDK's own source brings it`, async () => {
      const events: LogEvent[] = [];
      const own = defineTool({ name, description: "Deletes what it finds.", toolClass: "destructive", run: () => "deleted" });
      const sdk = { [CORE_TOOL_SOURCE]: true, getTools: async () => [{ ...tool(name), source: "sdk" }] };
      const app = await setup({ ...OPEN }, () => ApprovalDecision.approve(),
        (b) => b.addToolSource(fixed(own)).addToolSource(new Source("other")).useLogging({ log: (e) => { events.push(e); } }));
      const core = await boot({}, fixed(own), sdk);
      try {
        await app.agent.start();
        expect(app.agent.tools.map((t) => t.name)).not.toContain(name);
        expect(app.agent.tools.map((t) => t.name)).toContain("other");
        expect(events.filter((e) => e.eventId === 2016).map((e) => e.message)).toEqual([`A tool source's tool ${name} was left out: the name is the SDK's own`]);
        await core.agent.start();
        expect(core.agent.tools.find((t) => t.name === name)?.toolClass).toBe("read"); // the SDK's, though the app's source came first
      } finally { await app.agent.dispose(); await core.agent.dispose(); }
    });
  }

  it("a source's tool that loses its name is left out as before, and logged with what won", async () => {
    const events: LogEvent[] = [];
    const s = await setup({}, () => ApprovalDecision.approve(), (b) => b
      .addToolSource(fixed({ ...tool("read_page"), toolClass: "destructive" })).addToolSource(new Source("notes")).addToolSource(new Source("notes"))
      .useLogging({ log: (e) => { events.push(e); } }));
    try {
      await s.agent.start();
      expect(s.agent.tools.filter((t) => t.name === "read_page").map((t) => [t.source, t.toolClass])).toEqual([["host", "read"]]);
      expect(s.agent.tools.filter((t) => t.name === "notes")).toHaveLength(1);
      expect(events.filter((e) => e.eventId === 2017).map((e) => e.message)).toEqual([
        "A tool source's tool read_page was left out: the app's own tool has that name",
        "A tool source's tool notes was left out: an earlier tool source has that name",
      ]);
    } finally { await s.agent.dispose(); }
  });

  it("the agent's contract decides: a tool it leaves out is not found, an empty search is an error", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [{ name: "find_tool", risk: "read" }, { name: "get_file", risk: "read" }] }],
      ...script(call("find_tool", { query: "issues files" }), call("find_tool", { query: "  " }), { text: "Done." }) },
      () => ApprovalDecision.approve(), (b) => b.addToolSource(new OnRequestTools(github())));
    try {
      await (await s.agent.startSession("auto")).send("go");
      expect(toolNames(s, 1)).toEqual(["find_tool", "get_file"]);
      expect(lastResult(s, 2)).toBe("Error: give a few words about the tool you need as 'query'.");
    } finally { await s.agent.dispose(); }
  });
});
