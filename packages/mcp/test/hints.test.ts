import { describe, expect, it } from "vitest";

import { OpenAiFake } from "@fadenstack/testing";
import { MemoryMcpServerStore, McpServerState, mcpModule, toolClassFor, type McpServerStatus } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";
import { ask, call, calls, governed, server, standalone } from "./rig.js";

/** The class of each tool of the only server, by the name the model calls it. */
const classes = (status: McpServerStatus | undefined) => Object.fromEntries((status?.tools ?? []).map((t) => [t.name, t.toolClass]));

describe("the hint rule (H4)", () => {
  it.each([
    // [hints, trusted, raised, class]
    [undefined, false, undefined, "unknown"], // arrives unclassified, so it asks
    [{}, true, undefined, "unknown"],
    [{ destructiveHint: true }, false, undefined, "destructive"], // from any server
    [{ destructiveHint: true }, true, undefined, "destructive"],
    [{ readOnlyHint: true }, false, undefined, "unknown"], // an untrusted read-only hint is ignored
    [{ readOnlyHint: true }, true, undefined, "read"], // trust lets it count
    [{ readOnlyHint: false }, true, undefined, "unknown"], // "not read-only" never makes a tool a write
    [{ destructiveHint: false }, true, undefined, "unknown"],
    [{ readOnlyHint: true, destructiveHint: true }, true, undefined, "destructive"], // a contradiction is read strictly
    [{}, false, "read", "read"], // only the person (or the administrator) raises
    [{}, false, "write", "write"],
    [{ readOnlyHint: true }, true, "write", "write"],
    [{ destructiveHint: true }, false, "read", "destructive"], // destructive stays a floor
    [{ destructiveHint: true }, true, "write", "destructive"],
  ] as const)("hints %j, trusted %j, raised %j: %s", (hints, trusted, raised, expected) => {
    expect(toolClassFor(hints, { trusted, raised })).toBe(expected);
  });
});

describe("the hint rule in the module, standalone", () => {
  it("makes a destructive tool destructive and leaves the other two unclassified when the server is not trusted", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both));

    await ask(rig, "Hi");

    expect(classes(rig.module.statuses[0])).toEqual({ echo: "unknown", delete_file: "destructive", write_note: "unknown" });
  });

  it("lets a trusted server's read-only hint count, and a read tool runs without asking while an unclassified one asks", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both, { trusted: true }));
    rig.fake.answers.push(call("find_tool", { query: "echo write note" }, "c1"));
    rig.fake.answers.push(call("echo", { text: "a" }, "c2"));
    rig.fake.answers.push(call("write_note", { text: "b" }, "c3"));
    rig.fake.answers.push(OpenAiFake.text("Done."));
    const agent = rig.builder.build();

    await (await agent.startSession()).send("Go.");

    expect(classes(rig.module.statuses[0])).toEqual({ echo: "read", delete_file: "destructive", write_note: "unknown" });
    expect(rig.asked).toEqual(["write_note"]); // echo is read: no approval; write_note is unclassified: asks
    expect(calls(rig.fake).at(-1)!.toolResults.join("\n")).toContain("wrote:b");
  });

  it("asks for a destructive tool whatever the person or the server says", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both, { trusted: true, toolClasses: { delete_file: "read" } }));
    rig.fake.answers.push(call("find_tool", { query: "delete file" }, "c1"));
    rig.fake.answers.push(call("delete_file", { text: "x" }, "c2"));
    rig.fake.answers.push(OpenAiFake.text("Done."));

    await ask(rig, "Go.");

    expect(classes(rig.module.statuses[0])["delete_file"]).toBe("destructive");
    expect(rig.module.statuses[0]!.tools.find((t) => t.name === "delete_file")!.raisedTo).toBe("read"); // the raise is kept, and does not lower the floor
    expect(rig.asked).toEqual(["delete_file"]);
  });

  it("lets the person raise a tool to write or read, through the module, and take it back", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both));
    await rig.module.setToolClass("notes", "write_note", "write");
    await rig.module.setToolClass("notes", "echo", "read");

    const agent = await ask(rig, "Hi");
    expect(classes(rig.module.statuses[0])).toEqual({ echo: "read", delete_file: "destructive", write_note: "write" });

    await rig.module.setToolClass("notes", "write_note", undefined);
    await (await agent.startSession()).send("Again");
    expect(classes(rig.module.statuses[0])["write_note"]).toBe("unknown");
  });

  it("treats a server as untrusted again when the person takes the mark back", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.store.save(server("notes", fake.urls.both));
    await rig.module.setTrusted("notes", true);
    const agent = await ask(rig, "Hi");
    expect(classes(rig.module.statuses[0])["echo"]).toBe("read");

    await rig.module.setTrusted("notes", false);
    await (await agent.startSession()).send("Again");

    expect(classes(rig.module.statuses[0])["echo"]).toBe("unknown");
  });
});

describe("the hint rule in the module, governed", () => {
  const withModule = (options: Parameters<typeof mcpModule>[0], fake: FakeMcpServer) => {
    const store = new MemoryMcpServerStore();
    return { store, module: mcpModule({ store, fetch: fake.fetch as typeof fetch, ...options }) };
  };

  it("counts a read-only hint from a server the administrator trusts, and ignores the person's own mark", async () => {
    const fake = new FakeMcpServer();
    const mine = withModule({}, fake);
    const admin = withModule({ trustedServers: ["Notes"] }, fake);
    for (const { store } of [mine, admin]) await store.save(server("notes", fake.urls.both, { trusted: true, toolClasses: { write_note: "write" } }));

    const a = await governed({ localMcpMode: "allow" }, mine.module);
    await (await a.agent.startSession()).send("Hi");
    const b = await governed({ localMcpMode: "allow" }, admin.module);
    await (await b.agent.startSession()).send("Hi");

    // the person's trusted mark and raise mean nothing here
    expect(classes(mine.module.statuses[0])).toEqual({ echo: "unknown", delete_file: "destructive", write_note: "unknown" });
    // the administrator's list counts (without regard to case); the person's raise still does not
    expect(classes(admin.module.statuses[0])).toEqual({ echo: "read", delete_file: "destructive", write_note: "unknown" });
  });

  it("lets the agent's contract make a class stricter and drops what it does not list", async () => {
    const fake = new FakeMcpServer();
    const { store, module } = withModule({ trustedServers: ["notes"] }, fake);
    await store.save(server("notes", fake.urls.both));
    const contract = [{ name: "echo", risk: "write" as const }, { name: "write_note", risk: "write" as const }, { name: "delete_file" }];

    const { agent } = await governed({ localMcpMode: "allow", contract }, module);
    await (await agent.startSession()).send("Hi");

    expect(classes(module.statuses[0])).toEqual({ echo: "write", write_note: "write", delete_file: "destructive" }); // stricter of the hint and the contract
    expect(module.statuses[0]!.state).toBe(McpServerState.Running);

    const narrow = withModule({}, fake);
    await narrow.store.save(server("notes", fake.urls.both));
    const other = await governed({ localMcpMode: "allow", contract: [{ name: "echo", risk: "read" }] }, narrow.module);
    await (await other.agent.startSession()).send("Hi");
    expect(narrow.module.statuses[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });
});
