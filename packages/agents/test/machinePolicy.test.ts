import { describe, expect, it } from "vitest";

import { DirectChatClient, EndpointPlainHttpRefusedError, type ModelEndpoint } from "@fadenstack/client";
import {
  AgentDefinition,
  FadenstackAgent,
  MachinePolicy,
  MachinePolicyError,
  MemoryApprovalStore,
  MemorySessionStore,
  PolicyAccess,
  PolicyRule,
  TimestampingMode,
  TimestampingPolicy,
  type AgentBuilder,
  type LocalProfileOptions,
} from "@fadenstack/agents";
import { OpenAiFake } from "@fadenstack/testing";

import { setup } from "./helpers.js";

/**
 * sdk/51 F09: the machine policy's vocabulary, read fail-closed, and enforced in the SDK. Port of the .NET MachinePolicyTests
 * (7fcb18e). Not ported: `Load(path)` (a browser has no files: the `from` tests cover what `Load` hands on) and the
 * comments and trailing commas .NET's reader allows (JSON.parse is strict). The time-stamp switch is in the provenance tests.
 */
const DEFINITION = '{"slug":"docs-assistant","version":{"instructions":"Hi."}}';

function standalone(policy: MachinePolicy, baseUrl = "http://localhost:11434/v1", lan = false, options?: LocalProfileOptions, fake = new OpenAiFake()): AgentBuilder {
  const endpoint: ModelEndpoint = { baseUrl, model: "m", fetch: fake.fetch, allowPlainHttpInLan: lan };
  return FadenstackAgent.createBuilder()
    .useEndpoint(endpoint)
    .useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, options)
    .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
    .useMachinePolicy(policy);
}

describe("reading", () => {
  it("each key is read and locked", () => {
    const policy = MachinePolicy.fromJson(`
      {"server":"https://ai.example.test","standalone":"allowed","endpoints":["http://localhost:11434","https://llm.example.test/v1"],
       "plainHttp":"forbidden","mcp":["notes-db"],"skills":"allowed","webSearch":"forbidden","timestamping":"off"}`);

    expect(policy.server?.href).toBe("https://ai.example.test/");
    expect(policy.standalone).toBe(PolicyAccess.Allowed);
    expect(policy.endpoints).toEqual(["http://localhost:11434", "https://llm.example.test/v1"]);
    expect(policy.plainHttp).toBe(PolicyAccess.Forbidden);
    expect(policy.mcp.access).toBe(PolicyAccess.Listed);
    expect(policy.mcp.allows("NOTES-DB")).toBe(true);
    expect(policy.mcp.allows("other")).toBe(false);
    expect(policy.skills).toBe(PolicyRule.allowed);
    expect(policy.webSearch).toBe(PolicyAccess.Forbidden);
    expect(policy.timestamping).toBe(TimestampingPolicy.off);
    expect([...policy.locked].sort()).toEqual([...MachinePolicy.keys].sort());
    expect(policy.warnings).toEqual([]);
  });

  it("with a server and nothing else, standalone, mcp, skills and search are forbidden", () => {
    const policy = MachinePolicy.fromJson('{"server":"https://ai.example.test"}');

    expect(policy.standalone).toBe(PolicyAccess.Forbidden);
    expect(policy.mcp).toBe(PolicyRule.forbidden);
    expect(policy.skills).toBe(PolicyRule.forbidden);
    expect(policy.webSearch).toBe(PolicyAccess.Forbidden);
    expect(policy.plainHttp).toBe(PolicyAccess.Allowed);
    expect(policy.timestamping).toBe(TimestampingPolicy.on);
    expect(policy.locked).toEqual(["server"]);
  });

  it("without a server everything stays allowed", () => {
    const policy = MachinePolicy.fromJson("{}");

    expect(policy.standalone).toBe(PolicyAccess.Allowed);
    expect(policy.mcp).toBe(PolicyRule.allowed);
    expect(policy.endpoints).toBeNull();
    expect(policy.locked).toEqual([]);
  });

  it.each(["standalone", "plainHttp", "webSearch", "mcp", "skills"])("an unknown value narrows to forbidden: %s", (key) => {
    const policy = MachinePolicy.fromJson(`{"${key}":"sometimes"}`);

    const access = { standalone: policy.standalone, plainHttp: policy.plainHttp, webSearch: policy.webSearch, mcp: policy.mcp.access,
      skills: policy.skills.access }[key];
    expect(access).toBe(PolicyAccess.Forbidden);
    expect(policy.warnings.some((w) => w.includes(key) && !w.includes("sometimes"))).toBe(true); // never the value itself
  });

  it.each<[unknown, string, string | undefined]>([
    ["on", "on", undefined],
    ["off", "off", undefined],
    [" off ", "off", undefined],
    ["https://tsa.example.test/rfc3161", "ownServer", "https://tsa.example.test/rfc3161"],
    ["http://tsa.example.internal", "ownServer", "http://tsa.example.internal/"],
  ])("timestamping is on, off or an own server's address: %j", (value, mode, server) => {
    const policy = MachinePolicy.from({ timestamping: value });

    expect(policy.timestamping.mode).toBe(mode);
    expect(policy.timestamping.server?.href).toBe(server);
    expect(policy.warnings).toEqual([]);
  });

  it.each<unknown>(["sometimes", "ftp://tsa.example.test", true, 1, "https://u:p@tsa.example.test"])(
    "any other timestamping value is off, with a warning: %j", (value) => {
      const policy = MachinePolicy.from({ timestamping: value });

      expect(policy.timestamping.mode).toBe(TimestampingMode.Off);
      expect(policy.warnings).toEqual(["'timestamping' is neither on, off nor an http(s) address: off."]);
    });

  it("timestamping missing is on", () => {
    expect(MachinePolicy.from({}).timestamping).toBe(TimestampingPolicy.on);
  });

  it("a value of the wrong shape narrows too: a list where a word belongs, a word where a list belongs, a number", () => {
    expect(MachinePolicy.from({ standalone: ["allowed"] }).standalone).toBe(PolicyAccess.Forbidden);
    expect(MachinePolicy.from({ standalone: 1 }).standalone).toBe(PolicyAccess.Forbidden);
    expect(MachinePolicy.from({ endpoints: "https://llm.example.test" }).endpoints).toEqual([]);
    expect(MachinePolicy.from({ endpoints: ["https://llm.example.test", 5, ""] }).endpoints).toEqual(["https://llm.example.test"]);
    expect(MachinePolicy.from({ server: "ftp://ai.example.test" }).server).toBeUndefined();
    expect(MachinePolicy.from({ server: "not a url" }).warnings).toContain("'server' is not an http(s) address: ignored.");
  });

  it("an unknown key is ignored and reported", () => {
    const policy = MachinePolicy.fromJson('{"telemetry":"on","standalone":"allowed"}');

    expect(policy.standalone).toBe(PolicyAccess.Allowed);
    expect(policy.warnings.some((w) => w.includes("telemetry"))).toBe(true);
    expect(policy.locked).not.toContain("telemetry");
  });

  it.each([["[1,2]"], ['"forbidden"'], ["null"], ["5"]])("a policy the SDK cannot read forbids what it could have allowed: %s", (content) => {
    const policy = MachinePolicy.from(JSON.parse(content));

    expect(policy.standalone).toBe(PolicyAccess.Forbidden);
    expect(policy.mcp).toBe(PolicyRule.forbidden);
    expect(policy.skills).toBe(PolicyRule.forbidden);
    expect(policy.plainHttp).toBe(PolicyAccess.Forbidden);
    expect(policy.webSearch).toBe(PolicyAccess.Forbidden);
    expect(policy.timestamping).toBe(TimestampingPolicy.off);
    expect(policy.warnings.length).toBeGreaterThan(0);
  });

  it("unreadable, for a host whose policy source failed, forbids what none allows and leaves the server open", () => {
    const policy = MachinePolicy.unreadable;

    expect(policy).not.toBe(MachinePolicy.none);
    expect([policy.standalone, policy.plainHttp, policy.webSearch]).toEqual([PolicyAccess.Forbidden, PolicyAccess.Forbidden, PolicyAccess.Forbidden]);
    expect([policy.mcp, policy.skills]).toEqual([PolicyRule.forbidden, PolicyRule.forbidden]);
    expect(policy.mcp.allowsAny || policy.skills.allowsAny).toBe(false);
    expect(policy.timestamping).toBe(TimestampingPolicy.off);
    expect(policy.allowsEndpoint("http://localhost:11434/v1")).toBe(false);
    expect(policy.server).toBeUndefined();
    expect([...policy.locked].sort()).toEqual(MachinePolicy.keys.filter((k) => k !== "server").sort());
    expect(policy.warnings).toEqual([
      "The machine policy could not be read: standalone, local MCP, local skills, web search and plain http are forbidden; time-stamps are off.",
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("text that is not JSON throws, as .NET's FromJson does (its Load catches it and forbids)", () => {
    expect(() => MachinePolicy.fromJson("not json")).toThrow(SyntaxError);
  });

  it("a list that names nothing allows nothing", () => {
    const policy = MachinePolicy.from({ skills: [] });
    expect(policy.skills.access).toBe(PolicyAccess.Listed);
    expect(policy.skills.allowsAny).toBe(false);
    expect(MachinePolicy.from({ mcp: ["a"] }).mcp.allowsAny).toBe(true);
  });

  it("the policy and its rules are immutable", () => {
    const policy = MachinePolicy.from({ mcp: ["a"] });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.mcp)).toBe(true);
    expect(() => { (policy.mcp.items as string[]).push("b"); }).toThrow();
  });

  it.each<[string, boolean]>([
    ["http://localhost:11434/v1", true],
    ["http://localhost:11434/v1/", true],
    ["https://llm.example.test/v1", true],
    ["https://llm.example.test/v2", false],
    ["http://localhost:1234/v1", false],
  ])("an endpoint is allowed by its origin or its exact base: %s", (baseUrl, allowed) => {
    const policy = MachinePolicy.fromJson('{"endpoints":["http://localhost:11434","https://llm.example.test/v1"]}');

    expect(policy.allowsEndpoint(new URL(baseUrl))).toBe(allowed);
    expect(policy.allowsEndpoint(baseUrl)).toBe(allowed);
  });
});

describe("enforced in the SDK", () => {
  it("a forbidden standalone is refused at build", () => {
    const refusal = () => standalone(MachinePolicy.fromJson('{"server":"https://ai.example.test"}')).build();

    expect(refusal).toThrow(MachinePolicyError);
    expect((() => { try { refusal(); } catch (e) { return e as MachinePolicyError; } return undefined; })()?.key).toBe("standalone");
  });

  it("an unreadable policy refuses a standalone agent at build", () => {
    const keyOf = (build: () => unknown) => { try { build(); } catch (e) { return (e as MachinePolicyError).key; } return undefined; };

    expect(keyOf(() => standalone(MachinePolicy.unreadable).build())).toBe("standalone");
  });

  it("an endpoint the policy does not list is refused, and a host's client too", () => {
    const policy = MachinePolicy.fromJson('{"endpoints":["https://llm.example.test"]}');
    const keyOf = (build: () => unknown) => { try { build(); } catch (e) { return (e as MachinePolicyError).key; } return undefined; };

    expect(keyOf(() => standalone(policy).build())).toBe("endpoints");
    const host = FadenstackAgent.createBuilder()
      .useChatStreamer(new DirectChatClient({ baseUrl: "https://llm.example.test/v1", model: "m" }))
      .useLocalProfile(AgentDefinition.fromJson(DEFINITION)).useMachinePolicy(policy);
    expect(keyOf(() => host.build())).toBe("endpoints");
    expect(standalone(policy, "https://llm.example.test/v1").build()).toBeTruthy();
  });

  it("plain http in the LAN forbidden takes the opt-in away", async () => {
    const fake = new OpenAiFake();
    const agent = standalone(MachinePolicy.fromJson('{"plainHttp":"forbidden"}'), "http://192.168.1.20:8000/v1", true, undefined, fake).build();
    const session = await agent.startSession();

    const refused = await session.send("Hi").then(() => undefined, (e: unknown) => e);

    expect(refused).toBeInstanceOf(EndpointPlainHttpRefusedError);
    expect((refused as EndpointPlainHttpRefusedError).reason).toBe("forbiddenByPolicy");
    expect(fake.requests).toEqual([]);
    // Without the policy the same opt-in is honoured.
    const allowedFake = new OpenAiFake();
    const allowed = standalone(MachinePolicy.none, "http://192.168.1.20:8000/v1", true, undefined, allowedFake).build();
    expect((await (await allowed.startSession()).send("Hi")).text).toBe("Hello.");
    // This computer stays.
    const loopback = standalone(MachinePolicy.fromJson('{"plainHttp":"forbidden"}')).build();
    expect((await (await loopback.startSession()).send("Hi")).text).toBe("Hello.");
  });

  it("mcp and skills the policy forbids are off whatever the person set", async () => {
    const agent = standalone(MachinePolicy.fromJson('{"mcp":"forbidden","skills":[]}'), undefined, false, { localMcp: true, localSkills: true }).build();
    const open = standalone(MachinePolicy.fromJson('{"mcp":["notes-db"]}'), undefined, false, { localMcp: true }).build();
    const free = standalone(MachinePolicy.none, undefined, false, { localMcp: true }).build();

    await agent.start();
    await open.start();
    await free.start();

    expect(agent.profile.localMcp.mode).toBe("disable");
    expect(agent.profile.localSkills?.mode).toBe("disable");
    expect(open.profile.localMcp.mode).toBe("allow");
    expect(open.machinePolicy.mcp.access).toBe(PolicyAccess.Listed); // the module enforces the list
    expect(free.profile.localMcp.mode).toBe("allow");
    expect(free.profile.localSkills?.mode).toBe("allow");
  });

  it("the policy never turns on what the person left off", async () => {
    const agent = standalone(MachinePolicy.fromJson('{"mcp":"allowed"}')).build();
    await agent.start();
    expect(agent.profile.localMcp.mode).toBe("disable");
  });

  it("with a server the policy narrows what the server allows, on read and on refresh, and never widens", async () => {
    const mine = await setup({ agents: [{ slug: "docs", localMcpMode: "allow" }], users: [{ email: "user@example.com", password: "secret", developerMode: true }] }, undefined,
      (b) => b.useMachinePolicy(MachinePolicy.fromJson('{"server":"https://faden.test"}')));
    const free = await setup({ agents: [{ slug: "docs", localMcpMode: "allow" }] }, undefined, (b) => b.useMachinePolicy(MachinePolicy.fromJson("{}")));
    const off = await setup({ agents: [{ slug: "docs" }] }, undefined, (b) => b.useMachinePolicy(MachinePolicy.fromJson('{"mcp":"allowed"}')));

    await mine.agent.start();
    await free.agent.start();
    await off.agent.start();

    expect(mine.agent.profile.localMcp).toEqual({ mode: "disable", developerMode: false, plainHttp: "deny" });
    expect(free.agent.profile.localMcp.mode).toBe("allow");
    expect(off.agent.profile.localMcp.mode).toBe("disable"); // the policy never turns on what the server left off
    await mine.agent.refreshPolicy();
    expect(mine.agent.profile.localMcp.mode).toBe("disable");
  });

  it("without a policy nothing changes", () => {
    const agent = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "m", fetch: new OpenAiFake().fetch })
      .useLocalProfile(AgentDefinition.fromJson(DEFINITION)).build();

    expect(agent.machinePolicy).toBe(MachinePolicy.none);
  });

  it("the builder takes only a MachinePolicy", () => {
    expect(() => FadenstackAgent.createBuilder().useMachinePolicy({} as MachinePolicy)).toThrow(TypeError);
  });
});
