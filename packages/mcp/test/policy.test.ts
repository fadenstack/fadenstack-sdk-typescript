import { describe, expect, it } from "vitest";

import { MachinePolicy } from "@fadenstack/agents";
import { McpServerState, MemoryMcpServerStore, coreLocalMcpPolicy, mcpModule } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";
import { ask, governed, server, standalone } from "./rig.js";

const decide = (mode: string | undefined, developerMode: boolean, policy = MachinePolicy.none) =>
  coreLocalMcpPolicy.decide({ label: "notes" }, { localMcp: mode === undefined ? { mode: "", developerMode } : { mode, developerMode } } as never, policy);

/**
 * sdk/51 F05, "Policy": governed follows the profile's `local_mcp.mode` as the .NET module reads it; standalone follows the person's
 * settings under the machine policy's `mcp`; a server that was imported is off until the person switches it on.
 */
describe("the core policy", () => {
  it.each([
    ["allow", false, true],
    ["allow", true, true],
    ["disable", true, true], // developer mode
    ["disable", false, false],
    ["", false, false],
    [undefined, false, false],
    ["mystery", false, false], // unknown is off
    ["mystery", true, true],
  ] as const)("reads mode %j and developer mode %j as .NET does: %j", (mode, developer, allowed) => {
    expect(decide(mode, developer).allowed).toBe(allowed);
  });

  it("says why, in the words the person is shown", () => {
    expect(decide("mystery", false).reason).toBe("The agent's local MCP mode 'mystery' needs a policy this app does not have.");
    expect(decide("disable", false).reason).toBe("The agent does not allow local MCP servers.");
    expect(decide("allow", false).reason).toBe("The agent allows local MCP servers.");
    expect(decide("disable", true).reason).toBe("Developer mode.");
  });

  it("is off for a profile that says nothing about local MCP", () => {
    expect(coreLocalMcpPolicy.decide({ label: "x" }, {} as never, MachinePolicy.none).allowed).toBe(false);
  });

  it("lets the machine policy forbid every server, or allow the listed ones only, without regard to case", () => {
    expect(decide("allow", true, MachinePolicy.fromJson('{"mcp":"forbidden"}')).allowed).toBe(false);
    expect(decide("allow", false, MachinePolicy.fromJson('{"mcp":["Notes"]}')).allowed).toBe(true);
    const other = coreLocalMcpPolicy.decide({ label: "files" }, { localMcp: { mode: "allow", developerMode: false } } as never, MachinePolicy.fromJson('{"mcp":["Notes"]}'));
    expect(other).toEqual({ allowed: false, reason: "The machine policy does not list this MCP source." });
  });
});

describe("governed", () => {
  async function governedState(localMcpMode: "allow" | "disable" | undefined): Promise<{ state: string; offered: boolean }> {
    const fake = new FakeMcpServer();
    const store = new MemoryMcpServerStore();
    await store.save(server("notes", fake.urls.both));
    const module = mcpModule({ store, fetch: fake.fetch as typeof fetch });
    const { agent } = await governed(localMcpMode ? { localMcpMode } : {}, module);
    await (await agent.startSession()).send("Hi");
    return { state: module.statuses[0]!.state, offered: agent.tools.some((t) => t.name === "find_tool") && fake.rpcs.length > 0 };
  }

  it("attaches the person's servers when the profile says allow", async () => {
    expect(await governedState("allow")).toEqual({ state: McpServerState.Running, offered: true });
  });

  it.each([["disable"], [undefined]] as const)("never contacts a server when the profile says %j, and reports why", async (mode) => {
    const fake = new FakeMcpServer();
    const store = new MemoryMcpServerStore();
    await store.save(server("notes", fake.urls.both));
    const module = mcpModule({ store, fetch: fake.fetch as typeof fetch });
    const { agent } = await governed(mode ? { localMcpMode: mode } : {}, module);

    await (await agent.startSession()).send("Hi");

    expect(module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed, detail: "The agent does not allow local MCP servers." });
    expect(fake.seen).toEqual([]);
    expect(agent.tools.some((t) => t.source === "mcp")).toBe(false);
    expect(() => module.assertAllowed("notes")).toThrow(/is not allowed: The agent does not allow/);
  });
});

describe("standalone", () => {
  it("is on when the person turned local MCP on, and off when they did not", async () => {
    const fake = new FakeMcpServer();
    const on = standalone(fake, { localMcp: true });
    await on.store.save(server("notes", fake.urls.both));
    await ask(on, "Hi");
    expect(on.module.statuses[0]!.state).toBe(McpServerState.Running);

    const off = standalone(new FakeMcpServer(), { localMcp: false });
    await off.store.save(server("notes", fake.urls.both));
    const seen = fake.seen.length;
    await ask(off, "Hi");
    expect(off.module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed });
    expect(fake.seen.length).toBe(seen);
  });

  it("is off whatever the person set when the machine policy forbids local MCP", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake, { policy: MachinePolicy.fromJson('{"mcp":"forbidden"}') });
    await rig.store.save(server("notes", fake.urls.both));

    await ask(rig, "Hi");

    expect(rig.module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed });
    expect(fake.seen).toEqual([]);
  });

  it("attaches only the sources the machine policy lists", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake, { policy: MachinePolicy.fromJson('{"mcp":["notes"]}') });
    await rig.store.save(server("notes", fake.urls.both));
    await rig.store.save(server("other", fake.urls.legacy));

    await ask(rig, "Hi");

    const byLabel = Object.fromEntries(rig.module.statuses.map((s) => [s.label, s]));
    expect(byLabel["notes"]!.state).toBe(McpServerState.Running);
    expect(byLabel["other"]).toMatchObject({ state: McpServerState.NotAllowed, detail: "The machine policy does not list this MCP source." });
    expect(fake.seen.every((s) => s.path === "/mcp")).toBe(true); // nothing reached the other one
  });

  it("leaves a server off that the person has not switched on, and contacts nothing", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both, { enabled: false, reviewed: false }));

    await ask(rig, "Hi");

    expect(rig.module.statuses[0]).toMatchObject({ state: McpServerState.Off });
    expect(fake.seen).toEqual([]);

    await rig.module.setEnabled("notes", true);
    expect((await rig.module.servers())[0]).toMatchObject({ enabled: true, reviewed: true });
  });

  it("accepts a replacement policy", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake, { mcp: { policy: { decide: (s) => ({ allowed: s.label === "yes", reason: "Only yes." }) } } });
    await rig.store.save(server("yes", fake.urls.both));
    await rig.store.save(server("no", fake.urls.legacy));

    await ask(rig, "Hi");

    expect(rig.module.statuses.map((s) => [s.label, s.state])).toEqual([["no", McpServerState.NotAllowed], ["yes", McpServerState.Running]]);
  });
});
