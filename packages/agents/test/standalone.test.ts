import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EndpointDialect,
  FadenstackClient,
  StaticTokenProvider,
  loginWithPassword,
  type ChatMessage,
  type ChatOptions,
  type ChatStreamer,
  type ChatUpdate,
  type FadenstackLogger,
  type FetchLike,
  type LogEvent,
  type ModelEndpoint,
} from "@fadenstack/client";
import {
  AgentDefinition,
  ApprovalDecision,
  FadenstackAgent,
  MemoryApprovalStore,
  MemorySessionStore,
  StageOrder,
  defineTool,
  type AgentBuilder,
  type AgentContext,
  type LocalLanguageStore,
  type ToolSource,
} from "@fadenstack/agents";
import { FakeGateway, OpenAiFake } from "@fadenstack/testing";

import { PAGE_CONTRACT, Pages, setup } from "./helpers.js";

/**
 * sdk/51 F02 §3 and F03: an agent on the person's own endpoint (I02 commits 13 and 14, I03 commits 4a, 8 and 9). Port of the
 * .NET StandaloneAgentTests; what a browser does differently is said where it shows.
 */
const DEFINITION = {
  slug: "docs-assistant",
  name: "Docs assistant",
  version: {
    instructions: "You are the docs assistant.",
    host_tool_contract: [{ name: "read_page", risk: "read" }, { name: "add_comment", risk: "write" }, { name: "stamp", risk: "mystery" }],
    ui: { greeting: "Hello there." },
  },
};

const LOCAL = "http://localhost:11434/v1";

const readPage = defineTool<{ page: number }>({
  name: "read_page", description: "Reads a page.", toolClass: "read",
  parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
  run: ({ page }) => `Page ${page}: hello`,
});
const addComment = defineTool<{ text: string }>({
  name: "add_comment", description: "Adds a comment.", toolClass: "write",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: () => "added",
});
const stamp = defineTool({ name: "stamp", description: "Stamps.", toolClass: "read", run: () => "stamped" });

/** A standalone builder on a fake endpoint, with stores of its own in memory. */
function standalone(options: { base?: string; own?: string; definition?: object; endpoint?: Partial<ModelEndpoint> } = {}): { builder: AgentBuilder; fake: OpenAiFake } {
  const fake = new OpenAiFake();
  const builder = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: options.base ?? LOCAL, model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch, ...options.endpoint })
    .useLocalProfile(AgentDefinition.fromJson(options.definition ?? DEFINITION), options.own)
    .useSessionStore(new MemorySessionStore())
    .useApprovalStore(new MemoryApprovalStore());
  return { builder, fake };
}

const chats = (fake: OpenAiFake) => fake.requests.filter((r) => r.url.pathname.endsWith("/chat/completions"));

/** A stage that tells what the options it was given say. */
const seeing = (see: (options: ChatOptions | undefined) => void) => (inner: ChatStreamer): ChatStreamer => ({
  stream(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatUpdate> {
    see(options);
    return inner.stream(messages, options);
  },
});

describe("the notice for a standalone agent without the provenance module (sdk/51 F10)", () => {
  const capture = () => {
    const events: LogEvent[] = [];
    const logger: FadenstackLogger = { log: (event) => { events.push(event); } };
    return { logger, notices: () => events.filter((e) => e.eventId === 2054) };
  };

  it("is logged once, with the agent's slug", () => {
    const { logger, notices } = capture();
    standalone().builder.useLogging(logger).build();

    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.eventName).toBe("NoProvenanceModule");
    expect(notices()[0]!.level).toBe("warning");
    expect(notices()[0]!.fields["Agent"]).toBe("docs-assistant");
    expect(notices()[0]!.message).toContain("@fadenstack/provenance");
  });

  it("is not logged when a module named provenance is added", () => {
    const { logger, notices } = capture();
    standalone().builder.useLogging(logger).use({ name: "provenance", configure: () => undefined }).build();

    expect(notices()).toHaveLength(0);
  });

  it("is not logged for an agent with a server", () => {
    const { logger, notices } = capture();
    FadenstackAgent.createBuilder().useServer("https://faden.test", { getToken: () => Promise.resolve("t") } as never).useAgent("docs-assistant")
      .useLogging(logger).build();

    expect(notices()).toHaveLength(0);
  });
});

describe("the build rules (I03 commit 8)", () => {
  const server = () => FadenstackAgent.createBuilder().useServer("https://faden.test", { getToken: () => Promise.resolve("t") } as never).useAgent("docs-assistant");

  it("refuses a server and an endpoint together", () => {
    const builder = server().useEndpoint({ baseUrl: LOCAL, model: "m" }).useLocalProfile(AgentDefinition.fromJson(DEFINITION));
    expect(() => builder.build()).toThrow(/never both/);
    const withClient = FadenstackAgent.createBuilder().useClient(new FadenstackClient({ serverUrl: "https://faden.test", agent: "docs-assistant" }))
      .useEndpoint({ baseUrl: LOCAL, model: "m" }).useLocalProfile(AgentDefinition.fromJson(DEFINITION));
    expect(() => withClient.build()).toThrow(/never both/);
  });

  it("needs a local profile for an endpoint", () => {
    expect(() => FadenstackAgent.createBuilder().useEndpoint({ baseUrl: LOCAL, model: "m" }).build()).toThrow(/useLocalProfile/);
    expect(() => FadenstackAgent.createBuilder().useChatStreamer(new HostStreamer()).build()).toThrow(/useLocalProfile/);
  });

  it("takes one model only, and a local profile only with an endpoint", () => {
    const both = FadenstackAgent.createBuilder().useEndpoint({ baseUrl: LOCAL, model: "m" }).useChatStreamer(new HostStreamer())
      .useLocalProfile(AgentDefinition.fromJson(DEFINITION));
    expect(() => both.build()).toThrow(/one model/);
    expect(() => server().useLocalProfile(AgentDefinition.fromJson(DEFINITION)).build()).toThrow(/useLocalProfile is for an agent on an endpoint/);
  });

  it("takes the slug from the definition", () => {
    const { builder } = standalone();
    expect(builder.build().slug).toBe("docs-assistant");
    expect(() => standalone().builder.useAgent("word-assistant").build()).toThrow(/slug comes from the definition/);
    expect(standalone().builder.useAgent("docs-assistant").build().slug).toBe("docs-assistant");
  });

  it("still refuses two tools of one name, and the governed path keeps its errors", () => {
    expect(() => standalone().builder.addTools(readPage, readPage).build()).toThrow(/Two tools are named 'read_page'/);
    expect(() => FadenstackAgent.createBuilder().build()).toThrow(/Call useAgent/);
    expect(() => FadenstackAgent.createBuilder().useAgent("x").build()).toThrow(/Call useServer/);
  });
});

describe("the instructions, above the stages (I03 commit 4a)", () => {
  it("go first: the definition's, then the person's own, and the stages see them", async () => {
    const { builder, fake } = standalone({ own: "  Answer in German.  " });
    let seen: string | undefined;
    const agent = builder.addChatStage(StageOrder.custom, seeing((o) => { seen = o?.instructions; })).build();

    const session = await agent.startSession();
    await session.send("Hi");

    expect(seen).toBe("You are the docs assistant.\n\nAnswer in German.");
    const messages = chats(fake)[0]!.json()["messages"] as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: "You are the docs assistant.\n\nAnswer in German." });
    expect(messages[1]).toMatchObject({ role: "user" });
  });

  it("are the definition's alone without the person's, and the person's alone without the definition's", async () => {
    const { builder, fake } = standalone({ definition: { slug: "docs-assistant" }, own: "Be brief." });
    await (await builder.build().startSession()).send("Hi");
    expect((chats(fake)[0]!.json()["messages"] as { content: string }[])[0]!.content).toBe("Be brief.");

    const bare = standalone({ definition: { slug: "docs-assistant" } });
    await (await bare.builder.build().startSession()).send("Hi");
    expect((chats(bare.fake)[0]!.json()["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["user"]);
  });

  it("are counted in the history budget", async () => {
    const long = "i".repeat(4 * 900); // about 900 tokens
    const run = async (instructions: string) => {
      const { builder, fake } = standalone({ definition: { ...DEFINITION, version: { ...DEFINITION.version, instructions } } });
      const agent = builder.useHistoryBudget(1000).build();
      const session = await agent.startSession();
      fake.answers.push(OpenAiFake.text("a".repeat(4 * 200)));
      await session.send("q".repeat(4 * 50)); // turn 1: about 250 tokens in all
      await session.send("Second?");
      return (chats(fake).at(-1)!.json()["messages"] as { content: string }[]).map((m) => m.content);
    };

    // 900 of the 1000 tokens go to the instructions, so turn 1 no longer fits beside them; without the reserve it would.
    expect(await run(long)).toEqual([long, "Second?"]);
    expect(await run("Hi.")).toEqual(["Hi.", "q".repeat(200), "a".repeat(800), "Second?"]);
  });

  it("are not set on the device with a server, whose gateway adds the agent's", async () => {
    let seen: string | undefined = "unset";
    const s = await setup({}, undefined, (b) => b.addChatStage(StageOrder.custom, seeing((o) => { seen = o?.instructions; })));
    await (await s.agent.startSession()).send("Hi");

    expect(seen).toBeUndefined();
    expect(s.gateway.modelCalls[0]!.messages.some((m) => m.role === "system")).toBe(false);
  });
});

describe("the local profile (I02 commit 14)", () => {
  it("comes from the definition, with no server parts", async () => {
    const { builder } = standalone();
    const agent = builder.build();
    await agent.start();

    expect(agent.connection).toBe("standalone");
    expect(agent.serverClient).toBeUndefined();
    expect(() => agent.client).toThrow(/no Fadenstack server/);
    expect(agent.endpointUrl?.href).toBe(LOCAL);
    const p = agent.profile;
    expect(p).toMatchObject({ slug: "docs-assistant", name: "Docs assistant", model: "qwen3:14b", version: null, draft: false,
      images: false, skills: false, features: [], edition: "standalone", requiredClientModules: [], serverTools: null,
      principal: { tenantId: "standalone", userId: "standalone", agentId: "docs-assistant", deviceId: null },
      toolModes: { default: "ask", ceiling: "auto", max: "auto" },
      ui: { greeting: "Hello there.", model_residency: "private" },
      localMcp: { mode: "disable" }, localSkills: { mode: "allow" }, user: { language: null } });
    expect(p.approvals).toBeUndefined();
    expect(p.instructionsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.ceiling).toBe("auto");
    expect(agent.bypassOffered).toBe(false);
    expect(agent.grants.available).toBe(false);
    expect(await agent.listServerTools()).toEqual([]);
    expect(await agent.listSkills()).toEqual([]);
  });

  it("takes the person's settings: local MCP on, local skills off, vision said", async () => {
    const { builder } = standalone();
    const agent = builder.useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, { localMcp: true, localSkills: false, vision: true }).build();
    await agent.start();
    expect(agent.profile).toMatchObject({ localMcp: { mode: "allow" }, localSkills: { mode: "disable" }, vision: true });
  });

  it.each([
    ["https://203.0.113.5/v1", "external"],
    ["https://api.example.com/v1", "external"],
    ["http://192.168.1.20:8000/v1", "private"],
    ["http://localhost:11434/v1", "private"],
    ["http://[::1]:11434/v1", "private"],
    ["http://127.0.0.1:11434/v1", "private"],
  ])("sets the model's residency from the endpoint's address: %s is %s", async (base, residency) => {
    const { builder } = standalone({ base, endpoint: { allowPlainHttpInLan: true } });
    const agent = builder.build();
    await agent.start();
    expect(agent.profile.ui["model_residency"]).toBe(residency);
  });

  it("a host's own chat streamer is external, and is never closed by the agent", async () => {
    const streamer = new HostStreamer();
    const agent = FadenstackAgent.createBuilder().useChatStreamer(streamer).useLocalProfile(AgentDefinition.fromJson(DEFINITION))
      .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore()).build();
    await agent.start();
    expect(agent.profile.ui["model_residency"]).toBe("external");
    expect(agent.profile.model).toBeNull();
    expect(agent.endpointUrl).toBeUndefined();

    const result = await (await agent.startSession()).send("Hi");
    expect(result.text).toBe("echo");
    await agent.dispose();
    expect(streamer.closed).toBe(0); // TypeScript has no dispose for a streamer, so the host's is left as it is
    expect(streamer.calls).toBe(1);
  });

  it("an unknown risk asks, and without a contract every tool asks", async () => {
    const { builder } = standalone();
    const agent = builder.addTools(readPage, addComment, stamp).build();
    await agent.start();
    expect(agent.tools.find((t) => t.name === "stamp")!.toolClass).toBe("unknown");
    expect(agent.tools.find((t) => t.name === "read_page")!.toolClass).toBe("read");
    expect(agent.tools.find((t) => t.name === "add_comment")!.toolClass).toBe("write");

    const bare = standalone({ definition: { slug: "docs-assistant" } }).builder.addTools(readPage, addComment, stamp).build();
    await bare.start();
    expect(bare.tools.map((t) => t.toolClass)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("gives a tool source no server client", async () => {
    const seen: { connection?: string; server?: unknown; threw?: boolean } = {};
    const source: ToolSource = {
      getTools(context: AgentContext) {
        seen.connection = context.connection;
        seen.server = context.serverClient;
        try {
          void context.client;
          seen.threw = false;
        } catch {
          seen.threw = true;
        }
        return Promise.resolve([]);
      },
    };
    const agent = standalone().builder.addToolSource(source).build();
    await agent.start();
    expect(seen).toEqual({ connection: "standalone", server: undefined, threw: true });
    // a refresh builds the context again: it must not read the client
    agent.clock = () => Date.now() + 120_000;
    await agent.refreshProfile();
    expect(agent.context.connection).toBe("standalone");
    expect(() => agent.context.client).toThrow(/no Fadenstack server/);
  });

  it("has no events, no manifest and no grants to send anywhere", async () => {
    const { builder, fake } = standalone();
    const agent = builder.addTools(readPage).describeApp({ name: "Docs add-in" }).build();
    await agent.start();
    await agent.flush();
    await expect(agent.backend.createGrant({ kind: "bypass", minutes: 5 })).rejects.toThrow(/no grants/);
    await expect(agent.backend.startStepUp()).rejects.toThrow(/second sign-in/);
    await expect(agent.backend.answerApproval("a", true, "once")).rejects.toThrow(/gateway approval/);
    expect(await agent.backend.checkHostTool({ name: "x" } as never)).toMatchObject({ decision: "deny" });
    expect(fake.requests).toEqual([]);
  });
});

describe("the user's language", () => {
  it("is kept in memory for the run, and a bad tag is refused", async () => {
    const agent = standalone().builder.build();
    await agent.start();
    expect(agent.profile.user.language).toBeNull();

    expect(await agent.setUserLanguage("de")).toBe("de");
    expect(agent.profile.user.language).toBe("de");
    expect(await agent.setUserLanguage(" zh-Hans ")).toBe("zh-Hans");
    await expect(agent.setUserLanguage("de; drop")).rejects.toThrow(TypeError);
    await expect(agent.setUserLanguage("x".repeat(36))).rejects.toThrow(TypeError);
    expect(await agent.setUserLanguage(null)).toBeNull();
    expect(await agent.setUserLanguage("  ")).toBeNull();
    expect(agent.profile.user.language).toBeNull();
  });

  it("stays on the device: in the store the app passes, which the next agent reads", async () => {
    let kept: string | null = null;
    const store: LocalLanguageStore = { read: () => kept, write: (language) => { kept = language; } };
    const options = { languageStore: store };
    const first = standalone();
    const agent = first.builder.useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, options).build();
    await agent.start();
    expect(agent.profile.user.language).toBeNull();
    await agent.setUserLanguage("de");
    expect(kept).toBe("de");

    const next = standalone();
    const again = next.builder.useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, options).build();
    await again.start();
    expect(again.profile.user.language).toBe("de");
    expect([first.fake.requests, next.fake.requests]).toEqual([[], []]); // nothing to any endpoint for it
    await again.setUserLanguage(null);
    expect(kept).toBeNull();
  });

  it("reads an unreadable or an invalid stored tag as none", async () => {
    const throwing: LocalLanguageStore = { read: () => { throw new Error("denied"); }, write: () => undefined };
    const invalid: LocalLanguageStore = { read: () => Promise.resolve("not a tag!"), write: () => undefined };
    for (const languageStore of [throwing, invalid]) {
      const agent = standalone().builder.useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, { languageStore }).build();
      await agent.start();
      expect(agent.profile.user.language).toBeNull();
    }
  });
});

describe("the data guard (I02 commit 13)", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const names = async () => (await indexedDB.databases()).map((d) => d.name).sort();

  /** TypeScript has no adoption: an older SDK's shared databases are never moved to anyone (`FadenstackAgent`'s store settings). */
  it("keeps a standalone agent's stores apart from the shared base and from a governed user's", async () => {
    const model = (): { text: string } => ({ text: "Hi." });
    // An older SDK's chats, in the shared databases (a gateway that names no user).
    const old = new FakeGateway({ users: [{ email: "anna@example.com", password: "secret" }], model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: old.serverUrl, agent: "docs", fetch: old.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: old.serverUrl, email: "anna@example.com", password: "secret", fetch: old.fetch }));
    const older = FadenstackAgent.createBuilder().useClient(client).addTools(new Pages().read).build();
    await (await older.startSession("ask")).send("old chat");
    await older.dispose();
    expect(await names()).toEqual(["fadenstack-keys", "fadenstack-sessions"]);

    // A standalone start: its stores are its own, and the shared ones are neither read nor moved.
    const fake = new OpenAiFake();
    const own = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: LOCAL, model: "m", fetch: fake.fetch }).useLocalProfile(AgentDefinition.fromJson(DEFINITION)).build();
    await own.start();
    expect(await own.listSessions()).toEqual([]);
    await (await own.startSession()).send("standalone chat");
    expect((await own.listSessions()).length).toBe(1);
    await own.dispose();
    expect(await names()).toEqual([
      "fadenstack-keys", "fadenstack-keys:standalone:standalone",
      "fadenstack-sessions", "fadenstack-sessions:standalone:standalone",
    ]);

    // A governed person who signs in later gets a database of their own, and sees neither the standalone chat nor the older ones.
    const named = new FakeGateway({ users: [{ email: "anna@example.com", password: "secret" }], principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const governed = FadenstackClient.forAgent({ serverUrl: named.serverUrl, agent: "docs", fetch: named.fetch });
    await governed.tokens.signIn(await loginWithPassword({ apiUrl: named.serverUrl, email: "anna@example.com", password: "secret", fetch: named.fetch }));
    const anna = FadenstackAgent.createBuilder().useClient(governed.client).addTools(new Pages().read).build();
    await anna.start();
    expect(await anna.listSessions()).toEqual([]);
    await anna.dispose();
    expect(await names()).toContain("fadenstack-sessions:tenant-1:user-1");

    // The older chat is still in the shared database, where it was; the standalone one is still in its own.
    const again = FadenstackAgent.createBuilder().useClient(client).addTools(new Pages().read).build();
    expect((await again.listSessions()).length).toBe(1);
    await again.dispose();
    const back = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: LOCAL, model: "m", fetch: fake.fetch }).useLocalProfile(AgentDefinition.fromJson(DEFINITION)).build();
    expect((await back.listSessions()).length).toBe(1);
    await back.dispose();
  });
});

describe("a turn on the endpoint (I03 commit 9)", () => {
  it("runs a tool call against the endpoint, and nothing is sent to us or anyone else", async () => {
    const reached: string[] = [];
    const global = vi.fn(() => Promise.reject(new Error("a request left the endpoint's fetch")));
    vi.stubGlobal("fetch", global);
    try {
      const { builder, fake } = standalone();
      const wrapped: FetchLike = (input, init) => {
        reached.push(new URL(input instanceof Request ? input.url : String(input)).origin);
        return fake.fetch(input, init);
      };
      const gateway = new FakeGateway({ agents: [{ slug: "docs-assistant" }] }); // must receive nothing
      fake.answers.push(OpenAiFake.calls(["call-1", "read_page", '{"page":3}']), OpenAiFake.text("Page 3 says hello."));
      const agent = builder.useEndpoint({ baseUrl: LOCAL, model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: wrapped })
        .addTools(readPage, addComment, stamp).build();

      const session = await agent.startSession();
      const result = await session.send("What does page 3 say?");
      await agent.flush();
      await agent.dispose();

      expect(result).toMatchObject({ outcome: "completed", text: "Page 3 says hello." });
      expect(reached.length).toBeGreaterThan(0);
      expect(new Set(reached)).toEqual(new Set(["http://localhost:11434"]));
      expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["POST /v1/chat/completions", "POST /v1/chat/completions"]);
      const tool = (fake.requests[1]!.json()["messages"] as { role: string; tool_call_id?: string }[]).find((m) => m.role === "tool");
      expect(tool?.tool_call_id).toBe("call-1");
      expect(gateway.requests).toEqual([]);
      expect(global).not.toHaveBeenCalled();
      // no header of the gateway's, no field of the gateway's
      for (const request of fake.requests) {
        expect(Object.keys(request.headers).filter((h) => h.startsWith("x-faden-"))).toEqual([]);
        expect(request.json()).not.toHaveProperty("session_id");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks before a write tool, and a decline never reaches anything but the endpoint", async () => {
    const { builder, fake } = standalone();
    fake.answers.push(OpenAiFake.calls(["call-1", "add_comment", '{"text":"hi"}']), OpenAiFake.text("I did not add it."));
    const asked: string[] = [];
    const agent = builder.addTools(readPage, addComment, stamp)
      .useApprovals((request) => { asked.push(request.toolName); return Promise.resolve(ApprovalDecision.deny()); }).build();

    const session = await agent.startSession();
    const result = await session.send("Add a comment.");

    expect(asked).toEqual(["add_comment"]);
    expect(result.outcome).toBe("tool_denied");
    expect(fake.requests.map((r) => r.url.pathname)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
  });

  it("runs a write tool the person allowed", async () => {
    const { builder, fake } = standalone();
    fake.answers.push(OpenAiFake.calls(["call-1", "add_comment", '{"text":"hi"}']), OpenAiFake.text("Added."));
    const agent = builder.addTools(readPage, addComment, stamp).useApprovals(() => Promise.resolve(ApprovalDecision.approve())).build();
    const result = await (await agent.startSession()).send("Add a comment.");
    expect(result).toMatchObject({ outcome: "completed", text: "Added." });
  });
});

describe("the endpoint's watermark, recorded per answer (F10)", () => {
  it("each answer records what the endpoint did about its watermark, and a server's answer records none", async () => {
    const { builder, fake } = standalone();
    fake.chatHeaders["x-watermark"] = "false";
    const agent = builder.build();
    const session = await agent.startSession();
    await session.send("Hi");

    expect(agent.endpointWatermark?.status).toBe("Never");
    expect(agent.endpointWatermark?.requested).toBe(false);
    const answer = session.transcript.find((e) => e.type === "assistant.message")!;
    expect(answer.data["endpoint_marking"]).toEqual({ status: "Never", requested: false, confirmed: false, deterministic: false });

    // Without the server's word the key is absent, as .NET leaves out a null.
    const silent = standalone();
    const other = silent.builder.build();
    const s2 = await other.startSession();
    await s2.send("Hi");
    expect((s2.transcript.find((e) => e.type === "assistant.message")!.data["endpoint_marking"] as Record<string, unknown>)).not.toHaveProperty("confirmed");

    const governed = await setup({ model: () => ({ text: "Hi." }) });
    const g = await governed.agent.startSession();
    await g.send("Hi");
    expect(governed.agent.endpointWatermark).toBeUndefined();
    expect(g.transcript.find((e) => e.type === "assistant.message")!.data).not.toHaveProperty("endpoint_marking");
  });

  it("the status is the check's report when the app gave one, else the sourced table", async () => {
    const { builder } = standalone({ base: "https://api.anthropic.com/v1", endpoint: { key: new StaticTokenProvider("k") } });
    expect(builder.build().endpointWatermark?.status).toBe("Marks");
    const host = FadenstackAgent.createBuilder().useChatStreamer(new HostStreamer()).useLocalProfile(AgentDefinition.fromJson(DEFINITION)).build();
    expect(host.endpointWatermark?.status).toBe("Unknown");
  });

  it("deterministic sampling is said in the record", async () => {
    const { builder, fake } = standalone();
    const agent = builder.addChatStage(StageOrder.custom, (inner) => ({
      stream: (messages, options) => inner.stream(messages, { ...options, temperature: 0 }),
    })).build();
    const session = await agent.startSession();
    await session.send("Hi");
    expect(fake.requests).toHaveLength(1);
    expect(session.transcript.find((e) => e.type === "assistant.message")!.data["endpoint_marking"]).toMatchObject({ deterministic: true });
  });
});

/** A host's own model: it answers "echo", and notices a close. */class HostStreamer implements ChatStreamer {
  closed = 0;
  calls = 0;

  async *stream(): AsyncGenerator<ChatUpdate> {
    this.calls++;
    await Promise.resolve();
    yield { type: "text", text: "echo" };
    yield { type: "finish", reason: "stop" };
  }

  close(): void {
    this.closed++;
  }
}
