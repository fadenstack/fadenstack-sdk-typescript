import { describe, expect, it } from "vitest";

import {
  CloudToolsStatus,
  ImportNote,
  ImportProblem,
  ImportSkipReason,
  LocalPlainHttpRefusal,
  LocalServerState,
  LocalToolClass,
  LocalToolRaise,
  MachinePolicy,
  ServerProblem,
  TestOutcome,
  ToolsPolicy,
  newServerDraft,
  type ServerDraft,
} from "@fadenstack/agents";
import type { AgentToolInfo } from "@fadenstack/client";

import { McpToolsCatalog, agentToolsView, type AgentToolsView } from "../src/index.js";
import { FakeMcpServer } from "./fakeServer.js";
import { ask, server, standalone, type Rig } from "./rig.js";

/**
 * The Tools view's side of the MCP module (sdk/51 F05): the person's servers with their state, tools and classes, the trust mark and the
 * raises, the plain-http switch, the draft with kept header values, the test, the pasted import, the cloud tools. .NET: `McpToolsCatalogTests`.
 */
const URL_OK = "http://127.0.0.1:8931/mcp";
const LAN = "http://192.168.1.5:8931/mcp";
const WARNING = "2026-11-15";
const SECRET = "Bearer s3cr3t-token";

async function started(fake = new FakeMcpServer(), options: Parameters<typeof standalone>[1] = {}): Promise<{ rig: Rig; catalog: McpToolsCatalog; fake: FakeMcpServer }> {
  const rig = standalone(fake, options);
  await rig.store.save(server("files", URL_OK));
  const agent = await ask(rig, "hello");
  const catalog = new McpToolsCatalog(rig.module, agentToolsView(agent));
  await catalog.refresh();
  return { rig, catalog, fake };
}

function draft(more: Partial<ServerDraft> = {}): ServerDraft {
  return { ...newServerDraft(), label: "notes", url: "https://mcp.example.com/mcp", ...more };
}

describe("the page's lists", () => {
  it("lists a running server with its tools, their classes and the policy", async () => {
    const { catalog } = await started();
    expect(catalog.signedIn).toBe(true);
    expect(catalog.policy).toBe(ToolsPolicy.Allowed);
    expect(catalog.marksAreYours).toBe(true);
    expect(catalog.serversKeptOnDisk).toBe(false); // the rig's store is in memory
    const [files] = catalog.localServers;
    expect(files).toMatchObject({ label: "files", state: LocalServerState.Running, enabled: true, origin: "typed", where: URL_OK, plainHttpApplies: false });
    expect(files!.runningSince).toBeInstanceOf(Date);
    expect(files!.tools.map((t) => [t.name, t.class])).toEqual([
      ["echo", LocalToolClass.Unknown], ["delete_file", LocalToolClass.Destructive], ["write_note", LocalToolClass.Unknown],
    ]);
    expect(files!.tools[0]).toMatchObject({ readOnly: true, raise: LocalToolRaise.None });
  });

  it("is not signed in without a running agent, and says so for a policy that is not known", async () => {
    const rig = standalone(new FakeMcpServer());
    const catalog = new McpToolsCatalog(rig.module);
    expect(catalog.signedIn).toBe(false);
    expect(catalog.policy).toBe(ToolsPolicy.Unknown);
    expect(catalog.plainHttpPermitted).toBe(false);
    expect((await catalog.getCloudTools()).status).toBe(CloudToolsStatus.NotSignedIn);
  });

  it("says Starting for a server that is on and not attached yet, and Off for one that is off", async () => {
    const { rig, catalog } = await started();
    await rig.store.save(server("later", "https://later.example.com/mcp"));
    await rig.store.save(server("quiet", "https://quiet.example.com/mcp", { enabled: false }));
    await catalog.refresh();
    const state = (label: string) => catalog.localServers.find((s) => s.label === label)!.state;
    expect(state("later")).toBe(LocalServerState.Starting);
    expect(state("quiet")).toBe(LocalServerState.Off);
  });

  it("says Not allowed where the machine policy forbids MCP", async () => {
    const { catalog } = await started(new FakeMcpServer(), { policy: MachinePolicy.fromJson('{"mcp":"forbidden"}') });
    expect(catalog.policy).toBe(ToolsPolicy.NotAllowed);
    expect(catalog.localServers[0]!.state).toBe(LocalServerState.NotAllowed);
  });

  it("carries names of headers, never a value, and strips a query from the address", async () => {
    const rig = standalone(new FakeMcpServer());
    await rig.store.save(server("api", "https://mcp.example.com/mcp?token=abc", { headers: { Authorization: SECRET, "X-Empty": "" } }));
    const catalog = new McpToolsCatalog(rig.module);
    await catalog.refresh();
    const [api] = catalog.localServers;
    expect(api).toMatchObject({ secretNames: ["Authorization", "X-Empty"], missingValues: ["X-Empty"], where: "https://mcp.example.com/mcp" });
    expect(JSON.stringify(catalog.localServers)).not.toMatch(/s3cr3t|token=abc/);
  });

  it("tells the view when something moved, and stops after dispose", async () => {
    const { rig, catalog } = await started();
    let told = 0;
    const stop = catalog.onChanged(() => { told++; });
    await rig.store.save(server("more", "https://more.example.com/mcp"));
    await catalog.refresh();
    expect(told).toBeGreaterThan(0);
    stop();
    const before = told;
    await catalog.setEnabled("more", false);
    expect(told).toBe(before);
    catalog.dispose();
  });
});

describe("the marks", () => {
  it("raises a tool and takes it back, trusts a server so its read-only hint counts, and never raises a destructive one", async () => {
    const { catalog, rig } = await started();
    await catalog.setToolClass("files", "write_note", LocalToolRaise.Write);
    await catalog.setToolClass("files", "delete_file", LocalToolRaise.Read);
    await catalog.setToolClass("files", "no-such-tool", LocalToolRaise.Read);
    const cls = (name: string) => catalog.localServers[0]!.tools.find((t) => t.name === name)!;
    expect(cls("write_note")).toMatchObject({ class: LocalToolClass.Write, raise: LocalToolRaise.Write });
    expect(cls("delete_file")).toMatchObject({ class: LocalToolClass.Destructive, raise: LocalToolRaise.None });
    expect((await rig.store.get("files"))!.toolClasses).toEqual({ write_note: "write" });

    expect(cls("echo").class).toBe(LocalToolClass.Unknown); // the server's own word is not enough
    await catalog.setTrusted("files", true);
    expect(catalog.localServers[0]!.trusted).toBe(true);
    expect(cls("echo").class).toBe(LocalToolClass.Read);

    await catalog.setToolClass("files", "write_note", LocalToolRaise.None);
    expect(cls("write_note")).toMatchObject({ class: LocalToolClass.Unknown, raise: LocalToolRaise.None });
  });
});

describe("the switch", () => {
  it("turns on with the warning's version, writes the audit line, and off with none", async () => {
    const rig = standalone(new FakeMcpServer());
    await rig.store.save(server("nas", LAN, { enabled: false }));
    const agent = await ask(rig, "hi");
    const catalog = new McpToolsCatalog(rig.module, agentToolsView(agent));
    await catalog.refresh();
    expect(catalog.plainHttpPermitted).toBe(true);
    expect(catalog.localServers[0]).toMatchObject({ plainHttpApplies: true, plainHttpInLan: false });

    expect(await catalog.setPlainHttpInLan("nas", true, WARNING)).toBe(ServerProblem.None);
    expect(catalog.localServers[0]!.plainHttpInLan).toBe(true);
    expect(await catalog.setPlainHttpInLan("nas", false)).toBe(ServerProblem.None);
    expect(catalog.localServers[0]!.plainHttpInLan).toBe(false);
    const audit = await rig.store.audit();
    expect(audit.map((a) => [a.state, a.warning_version])).toEqual([["on", WARNING], ["off", null]]);
  });

  it("is refused for a server that is sent a header, and says it as a problem", async () => {
    const rig = standalone(new FakeMcpServer());
    await rig.store.save(server("api", "http://127.0.0.1:3000/mcp", { headers: { Authorization: SECRET } }));
    const catalog = new McpToolsCatalog(rig.module);
    expect(await catalog.setPlainHttpInLan("api", true, WARNING)).toBe(ServerProblem.PlainHttpWithHeaders);
  });

  it("shows each refusal the module gives, and that the policy forbids it", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake, { policy: MachinePolicy.fromJson('{"plainHttp":"forbidden"}') });
    await rig.store.save(server("off-switch", LAN));
    await rig.store.save(server("on-switch", "http://192.168.1.6:8931/mcp", { plainHttpInLan: true }));
    const agent = await ask(rig, "hi");
    const catalog = new McpToolsCatalog(rig.module, agentToolsView(agent));
    await catalog.refresh();
    expect(catalog.plainHttpPermitted).toBe(false);
    const refusal = (label: string) => catalog.localServers.find((s) => s.label === label)!;
    expect(refusal("off-switch")).toMatchObject({ state: LocalServerState.NotAllowed, plainHttpRefusal: LocalPlainHttpRefusal.NoOptIn });
    expect(refusal("on-switch")).toMatchObject({ state: LocalServerState.NotAllowed, plainHttpRefusal: LocalPlainHttpRefusal.NotAllowed });
    expect(fake.seen).toHaveLength(0);
  });
});

describe("the sheet", () => {
  it("checks a draft for each rule and says which", async () => {
    const { catalog } = await started();
    const problem = (d: Partial<ServerDraft>, original?: string) => catalog.validate(draft(d), original);
    expect(problem({})).toBe(ServerProblem.None);
    expect(problem({ label: " " })).toBe(ServerProblem.LabelMissing);
    expect(problem({ label: "-bad" })).toBe(ServerProblem.LabelInvalid);
    expect(problem({ label: "FILES" })).toBe(ServerProblem.LabelTaken);
    expect(problem({ label: "files" }, "files")).toBe(ServerProblem.None);
    expect(problem({ url: "" })).toBe(ServerProblem.AddressMissing);
    expect(problem({ url: "not a url" })).toBe(ServerProblem.AddressInvalid);
    expect(problem({ url: "ftp://x.example.com" })).toBe(ServerProblem.AddressInvalid);
    expect(problem({ callTimeoutSeconds: 4 })).toBe(ServerProblem.TimeoutOutOfRange);
    expect(problem({ callTimeoutSeconds: 601 })).toBe(ServerProblem.TimeoutOutOfRange);
    expect(problem({ headers: [{ name: "bad name", value: "x", isKept: false }] })).toBe(ServerProblem.NameInvalid);
    expect(problem({ headers: [{ name: "A", value: "x\ny", isKept: false }] })).toBe(ServerProblem.ValueInvalid);
    expect(problem({ headers: [{ name: "A", value: "1", isKept: false }, { name: "a", value: "2", isKept: false }] })).toBe(ServerProblem.NameInvalid);
    expect(problem({ url: LAN, headers: [{ name: "A", value: "x", isKept: false }] })).toBe(ServerProblem.PlainHttpWithHeaders);
    expect(problem({ url: "http://8.8.8.8/mcp" })).toBe(ServerProblem.PlainHttpNotLocal);
    expect(problem({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `H${i}`, value: "x", isKept: false })) })).toBe(ServerProblem.TooManyHeaders);
  });

  it("saves a new server off or on, replaces one, and renames it", async () => {
    const { catalog, rig } = await started();
    expect(await catalog.save(undefined, draft({ enabled: false }))).toBe(ServerProblem.None);
    expect(await rig.store.get("notes")).toMatchObject({ enabled: false, reviewed: true, url: "https://mcp.example.com/mcp", callTimeoutS: 120 });
    expect(await catalog.save("notes", draft({ label: "notes-2", url: "https://other.example.com/mcp", callTimeoutSeconds: 30 }))).toBe(ServerProblem.None);
    expect(await rig.store.get("notes")).toBeUndefined();
    expect(await rig.store.get("notes-2")).toMatchObject({ url: "https://other.example.com/mcp", callTimeoutS: 30 });
    expect(await catalog.save(undefined, draft({ label: "NOTES-2" }))).toBe(ServerProblem.LabelTaken);
  });

  it("opens a draft with header names and kept marks, never a value, and keeps the saved value unless it is replaced", async () => {
    const { catalog, rig } = await started();
    await catalog.save(undefined, draft({ headers: [{ name: "Authorization", value: SECRET, isKept: false }, { name: "X-Org", value: "acme", isKept: false }] }));
    const opened = (await catalog.getDraft("notes"))!;
    expect(opened.headers).toEqual([{ name: "Authorization", value: "", isKept: true }, { name: "X-Org", value: "", isKept: true }]);
    expect(JSON.stringify(opened)).not.toMatch(/s3cr3t|acme/);

    opened.headers[1] = { name: "X-Org", value: "globex", isKept: false };
    expect(await catalog.save("notes", opened)).toBe(ServerProblem.None);
    expect((await rig.store.get("notes"))!.headers).toEqual({ Authorization: SECRET, "X-Org": "globex" });
    expect(await catalog.getDraft("missing")).toBeUndefined();
  });

  it("keeps the marks and the switch of a saved server on an edit, and turns the switch off, on the record, when the address moved", async () => {
    const { catalog, rig } = await started();
    await rig.store.save(server("nas", LAN, { trusted: true, toolClasses: { write_note: "write" }, plainHttpInLan: true }));
    await catalog.refresh();
    const same = (await catalog.getDraft("nas"))!;
    same.callTimeoutSeconds = 45;
    await catalog.save("nas", same);
    expect(await rig.store.get("nas")).toMatchObject({ trusted: true, toolClasses: { write_note: "write" }, plainHttpInLan: true, callTimeoutS: 45 });

    const moved = (await catalog.getDraft("nas"))!;
    moved.url = "http://192.168.1.99:8931/mcp";
    await catalog.save("nas", moved);
    expect((await rig.store.get("nas"))!.plainHttpInLan).toBeUndefined();
    expect((await rig.store.audit()).map((a) => a.state)).toEqual(["off"]);
  });

  it("tests a draft: the tools of a running server, a refusal of plain http, a failure, and a policy that forbids it", async () => {
    const { catalog, fake } = await started();
    const ok = await catalog.test(draft({ url: URL_OK }), undefined);
    expect(ok).toMatchObject({ outcome: TestOutcome.Started, tools: ["echo", "delete_file", "write_note"] });

    const refused = await catalog.test(draft({ url: LAN }), undefined);
    expect(refused).toMatchObject({ outcome: TestOutcome.Failed, plainHttp: LocalPlainHttpRefusal.NoOptIn });
    expect(fake.seen.every((s) => s.headers["host"] !== "192.168.1.5:8931")).toBe(true);

    const failed = await catalog.test(draft({ url: "http://127.0.0.1:8931/nope" }), undefined);
    expect(failed.outcome).toBe(TestOutcome.Failed);
    expect(failed.error).toBeTruthy();
    expect(failed.error).not.toContain("127.0.0.1");

    const blocked = (await started(new FakeMcpServer(), { policy: MachinePolicy.fromJson('{"mcp":"forbidden"}') })).catalog;
    expect((await blocked.test(draft({ url: URL_OK }), undefined)).outcome).toBe(TestOutcome.NotAllowed);
  });

  it("sends a header to the server when it tests, and never puts its value in the result", async () => {
    const fake = new FakeMcpServer({ requireAuthorization: SECRET });
    const { catalog } = await started(fake);
    const result = await catalog.test(draft({ url: URL_OK, headers: [{ name: "Authorization", value: SECRET, isKept: false }] }), undefined);
    expect(result.outcome).toBe(TestOutcome.Started);
    const wrong = await catalog.test(draft({ url: URL_OK, headers: [{ name: "Authorization", value: "Bearer nope", isKept: false }] }), undefined);
    expect(wrong.outcome).toBe(TestOutcome.Failed);
    expect(JSON.stringify([result, wrong])).not.toMatch(/s3cr3t|nope/);
  });

  it("removes a server and restarts one by connecting again at the next message", async () => {
    const { catalog, rig, fake } = await started();
    const initializes = () => fake.rpcs.filter((r) => r === "initialize" || r === "server/discover").length;
    const before = initializes();
    await ask(rig, "again");
    expect(initializes()).toBe(before); // the connection is kept between messages
    await catalog.restart("files");
    await ask(rig, "after restart");
    expect(initializes()).toBe(before + 1);
    await catalog.restart("no-such-server");
    await catalog.remove("files");
    expect(catalog.localServers).toEqual([]);
  });
});

describe("the pasted import", () => {
  const PASTED = JSON.stringify({ mcpServers: {
    remote: { type: "http", url: "https://remote.example.com/mcp", headers: { Authorization: "Bearer pasted-secret", "X-Key": "${env:KEY}" } },
    files: { type: "http", url: "https://files-clash.example.com/mcp" },
    nas: { type: "http", url: LAN },
    prog: { command: "npx", args: ["x"] },
    old: { type: "sse", url: "https://sse.example.com/mcp" },
    none: { type: "http" },
    weird: { type: "http", url: "ftp://x.example.com" },
  } });

  it("previews names only, says why each other server is not offered, and copies nothing", async () => {
    const { catalog, rig } = await started();
    const preview = await catalog.readImport(PASTED);
    expect(preview.problem).toBe(ImportProblem.None);
    expect(preview.servers).toEqual([{ label: "remote", where: "https://remote.example.com/mcp", notes: [ImportNote.HeadersLeftOut], detail: "X-Key" }]);
    expect(preview.skipped.map((s) => [s.name, s.reason])).toEqual([
      ["nas", ImportSkipReason.NetworkServer], ["prog", ImportSkipReason.Program], ["old", ImportSkipReason.Sse],
      ["none", ImportSkipReason.NothingToStart], ["weird", ImportSkipReason.NotValid], ["files", ImportSkipReason.LabelTaken],
    ]);
    expect(preview.skipped.find((s) => s.name === "weird")!.problem).toBe(ServerProblem.AddressInvalid);
    expect(JSON.stringify(preview)).not.toContain("pasted-secret");
    expect((await rig.store.list()).map((s) => s.label)).toEqual(["files"]);
  });

  it("adds only the ticked ones, switched off, not reviewed, not trusted, the switch off, with the header values kept", async () => {
    const { catalog, rig } = await started();
    const preview = await catalog.readImport(PASTED);
    expect(await catalog.import(preview, ["remote", "files", "prog"])).toBe(1);
    expect(await catalog.import(preview, ["remote"])).toBe(0); // a preview is used once
    const added = (await rig.store.get("remote"))!;
    expect(added).toMatchObject({ enabled: false, reviewed: false, trusted: false, toolClasses: {}, importedFrom: "mcpServers", headers: { Authorization: "Bearer pasted-secret" } });
    expect(added.plainHttpInLan).toBeUndefined();
    expect(catalog.localServers.find((s) => s.label === "remote")).toMatchObject({ origin: "mcpServers", state: LocalServerState.Off });
  });

  it.each([
    ["", ImportProblem.Empty],
    ["not json", ImportProblem.NotJson],
    ["{}", ImportProblem.NoServerList],
    ["x".repeat(300 * 1024), ImportProblem.TooLarge],
  ])("says why a text cannot be read (%#)", async (text, problem) => {
    const { catalog } = await started();
    expect(await catalog.readImport(text)).toEqual({ problem, servers: [], skipped: [] });
  });
});

describe("the cloud tools", () => {
  function viewWith(list: () => Promise<AgentToolInfo[] | null>, connection: "governed" | "standalone" = "governed"): AgentToolsView {
    return { isRunning: true, connection, context: undefined, listCloudTools: list, onChanged: () => () => undefined };
  }
  const tool = (name: string, more: Partial<AgentToolInfo> = {}): AgentToolInfo => ({ name, server: "crm", description: `${name} tool`, allowed: true, enabled: true, ...more }) as AgentToolInfo;

  it("lists them, and says when the server lists none, or cannot be read", async () => {
    const rig = standalone(new FakeMcpServer());
    const list = (answer: () => Promise<AgentToolInfo[] | null>) => new McpToolsCatalog(rig.module, viewWith(answer)).getCloudTools();
    const listed = await list(async () => [tool("find"), tool("off", { enabled: false })]);
    expect(listed.status).toBe(CloudToolsStatus.Listed);
    expect(listed.tools.map((t) => [t.name, t.server, t.allowed, t.enabled])).toEqual([["find", "crm", true, true], ["off", "crm", true, false]]);
    expect((await list(async () => null)).status).toBe(CloudToolsStatus.NotListed);
    expect((await list(async () => { throw new Error("down"); })).status).toBe(CloudToolsStatus.Unavailable);
  });

  it("leaves the marks to the administrator when governed", async () => {
    const rig = standalone(new FakeMcpServer());
    await rig.store.save(server("files", URL_OK));
    const catalog = new McpToolsCatalog(rig.module, viewWith(async () => []));
    expect(catalog.marksAreYours).toBe(false);
    await catalog.setTrusted("files", true);
    await catalog.setToolClass("files", "echo", LocalToolRaise.Write);
    expect((await rig.store.get("files"))).toMatchObject({ trusted: false, toolClasses: {} });
  });
});
