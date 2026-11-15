import { describe, expect, it } from "vitest";

import { ApprovalDecision, FadenstackAgent, MachinePolicy, MemoryApprovalStore, MemorySessionStore } from "@fadenstack/agents";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

import {
  McpConfigError,
  McpPlainHttpRefusedError,
  McpServerState,
  MemoryMcpServerStore,
  PLAIN_HTTP_EVENT_FEATURE,
  checkMcpPlainHttp,
  checkServer,
  mcpModule,
  mcpOrigin,
  type McpPlainHttpRefusal,
} from "../src/index.js";
import { FakeMcpServer } from "./fakeServer.js";
import { ask, server, standalone } from "./rig.js";

/**
 * Where an MCP server over HTTP may be reached (sdk/51 F05; OWASP ASVS 5.0 V12), in a browser: https anywhere; plain http to this
 * computer, and to the local network only with the person's switch, where the agent's profile and this computer's policy allow
 * it, and never with a header value. A browser cannot resolve names, so the host's spelling decides (`hostScope`). Every change
 * of the switch goes into the device's audit log and, governed and where the profile lists the feature, to the server.
 * .NET: `McpPlainHttpTests`.
 */
const LAN = "http://192.168.1.5:8931/mcp"; // the fake server answers by path: nothing leaves the process
const WARNING = "2026-11-15";

function refusal(run: () => unknown): McpPlainHttpRefusal | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof McpPlainHttpRefusedError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("the rule", () => {
  it("lets https go anywhere and plain http to this computer, a header only to the three spellings", () => {
    expect(checkMcpPlainHttp(new URL("https://mcp.example.com/mcp"), { headers: { A: "b" } }, false)).toBe(false);
    expect(checkMcpPlainHttp(new URL("http://localhost:3000/mcp"), { headers: { A: "b" } }, false)).toBe(false);
    expect(checkMcpPlainHttp(new URL("http://127.0.0.1:3000/mcp"), { headers: { A: "b" } }, false)).toBe(false);
    expect(checkMcpPlainHttp(new URL("http://[::1]:3000/mcp"), { headers: { A: "b" } }, false)).toBe(false);
    expect(checkMcpPlainHttp(new URL("http://127.0.0.2:3000/mcp"), {}, false)).toBe(false);
    expect(refusal(() => checkMcpPlainHttp(new URL("http://127.0.0.2:3000/mcp"), { headers: { A: "b" } }, false))).toBe("secret");
    expect(refusal(() => checkMcpPlainHttp(new URL("http://app.localhost:3000/mcp"), { headers: { A: "b" } }, false))).toBe("secret");
  });

  it.each([
    ["http://192.168.1.5:8080/mcp"],
    ["http://10.0.0.7/mcp"],
    ["http://172.16.4.2/mcp"],
    ["http://169.254.10.1/mcp"],
    ["http://[fd00::7]:3000/mcp"],
    ["http://[fe80::1]/mcp"],
    ["http://nas/mcp"],
    ["http://nas.local:8080/mcp"],
    ["http://printer.lan/mcp"],
    ["http://box.home.arpa/mcp"],
  ])("lets %s through with the switch where it is allowed", (url) => {
    expect(checkMcpPlainHttp(new URL(url), { plainHttpInLan: true }, true)).toBe(true);
  });

  it("refuses the local network with a header, without the switch, or where it is not allowed", () => {
    const url = new URL("http://192.168.1.5:8080/mcp");
    expect(refusal(() => checkMcpPlainHttp(url, { headers: { A: "b" }, plainHttpInLan: true }, true))).toBe("secret");
    expect(refusal(() => checkMcpPlainHttp(url, {}, true))).toBe("noOptIn");
    expect(refusal(() => checkMcpPlainHttp(url, { plainHttpInLan: true }, false))).toBe("notAllowed");
  });

  it.each([["http://8.8.8.8/mcp"], ["http://100.64.0.1/mcp"], ["http://[2001:db8::1]/mcp"], ["http://mcp.example.com/mcp"]])(
    "refuses %s outside the local network with the switch too", (url) => {
      expect(refusal(() => checkMcpPlainHttp(new URL(url), { plainHttpInLan: true }, true))).toBe("notLocal");
    });

  it("gives the origin only", () => {
    expect(mcpOrigin(new URL("http://192.168.10.20:8080/mcp?token=x#y"))).toBe("http://192.168.10.20:8080");
    expect(mcpOrigin(new URL("http://[fd00::7]:3000/mcp"))).toBe("http://[fd00::7]:3000");
    expect(mcpOrigin(new URL("http://nas.local/mcp"))).toBe("http://nas.local");
  });
});

describe("the entry", () => {
  it("keeps a plain-http host on the local network to wait for the switch, and never one with a header or outside it", () => {
    expect(() => checkServer({ label: "nas", url: LAN })).not.toThrow();
    expect(() => checkServer({ label: "far", url: "https://mcp.example.com/mcp", headers: { A: "b" } })).not.toThrow();
    const withHeader = (() => { try { checkServer({ label: "nas", url: LAN, headers: { A: "b" } }); } catch (e) { return e; } })();
    expect(withHeader).toBeInstanceOf(McpConfigError);
    expect((withHeader as McpConfigError).problem).toBe("plainHttpWithHeaders");
    const outside = (() => { try { checkServer({ label: "far", url: "http://8.8.8.8/mcp" }); } catch (e) { return e; } })();
    expect((outside as McpConfigError).problem).toBe("plainHttpNotLocal");
  });

  it("is imported without the switch: plain http beyond this computer is left out", async () => {
    const outcome = await mcpModule({ store: new MemoryMcpServerStore() }).importConfig(JSON.stringify({ mcpServers: {
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
      nas: { type: "http", url: LAN },
    } }));
    expect(outcome.added).toEqual(["remote"]);
    expect(outcome.skipped).toEqual([expect.objectContaining({ label: "nas", kind: "plainHttp" })]);
  });
});

describe("the agent", () => {
  it("attaches a server on the local network with the switch, and stops it at the next turn once the switch is off", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("nas", LAN, { plainHttpInLan: true }));

    await ask(rig, "hello");
    expect(rig.module.statuses[0]).toMatchObject({ label: "nas", state: McpServerState.Running, plainHttpInLan: true });

    await rig.module.setPlainHttpInLan("nas", false);
    const seen = fake.seen.length;
    await ask(rig, "again");
    expect(rig.module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed, plainHttp: "noOptIn" });
    expect(fake.seen.length).toBe(seen); // refused before anything was sent
  });

  it.each([
    ["this computer's policy forbids plain http", MachinePolicy.fromJson('{"plainHttp":"forbidden"}'), "notAllowed"],
  ] as const)("refuses the server where %s, before anything is sent", async (_why, policy, reason) => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake, { policy });
    await rig.store.save(server("nas", LAN, { plainHttpInLan: true }));

    await ask(rig, "hello");

    expect(rig.module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed, plainHttp: reason });
    expect(fake.seen).toHaveLength(0);
  });

  it("refuses a server without the switch before anything is sent", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("nas", LAN));
    await ask(rig, "hello");
    expect(rig.module.statuses[0]).toMatchObject({ state: McpServerState.NotAllowed, plainHttp: "noOptIn" });
    expect(fake.seen).toHaveLength(0);
  });
});

describe("the switch", () => {
  it("needs the version of the warning to turn on, and puts every change into the device's audit log with the origin only", async () => {
    const store = new MemoryMcpServerStore();
    const module = mcpModule({ store });
    await store.save(server("nas", "http://192.168.1.5:8931/mcp?x=1", { enabled: false }));

    await expect(module.setPlainHttpInLan("nas", true)).rejects.toThrow(/version of the warning/);
    expect(await store.audit()).toEqual([]);
    await module.setPlainHttpInLan("nas", true, WARNING);
    expect((await store.get("nas"))?.plainHttpInLan).toBe(true);
    await module.setPlainHttpInLan("nas", false);
    await module.setPlainHttpInLan("nas", false); // no change: no line

    const audit = await store.audit();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ event: "local_mcp.plain_http", source: "http://192.168.1.5:8931", state: "on", warning_version: WARNING, person: "standalone" });
    expect(audit[1]).toMatchObject({ state: "off", warning_version: null });
    expect(JSON.stringify(audit)).not.toContain("x=1");
  });

  it("is refused for a server sent a header value", async () => {
    const store = new MemoryMcpServerStore();
    const module = mcpModule({ store });
    await store.save(server("api", "http://127.0.0.1:3000/mcp", { headers: { Authorization: "Bearer t" } }));
    await expect(module.setPlainHttpInLan("api", true, WARNING)).rejects.toThrow(/header over plain http/);
    expect(await store.audit()).toEqual([]);
  });

  it.each([true, false])("goes to the server governed only where the profile lists the feature (listed: %s)", async (listed) => {
    const store = new MemoryMcpServerStore();
    const module = mcpModule({ store });
    await store.save(server("nas", LAN, { enabled: false }));
    const gateway = new FakeGateway({ agents: [{ slug: "docs", localMcpMode: "allow" }], model: () => ({ text: "Hello." }),
      ...(listed ? { features: [PLAIN_HTTP_EVENT_FEATURE] } : {}) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore())
      .useApprovalStore(new MemoryApprovalStore()).useApprovals(() => Promise.resolve(ApprovalDecision.approve())).use(module).build();
    await (await agent.startSession()).send("hello");

    await module.setPlainHttpInLan("nas", true, WARNING);
    await (await agent.startSession()).send("again");

    const sent = gateway.reported.filter((e) => e["type"] === "local_mcp.plain_http");
    expect(sent).toEqual(listed ? [expect.objectContaining({ source: "http://192.168.1.5:8931", state: "on" })] : []);
  });
});
