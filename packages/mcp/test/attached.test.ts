import { describe, expect, it } from "vitest";

import { MemoryMcpServerStore, mcpModule } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";
import { governed, server } from "./rig.js";

// .NET: LocalMcpModule.ReportAttachedAsync. The server learns which of the person's servers joined, by label, address and tool names.
describe("local_mcp.attached", () => {
  it("tells a governed server once per connection, with the address cut to scheme, host, port and path", async () => {
    const fake = new FakeMcpServer();
    const store = new MemoryMcpServerStore();
    await store.save(server("notes", `${fake.urls.both}?token=s3cret-query#s3cret-frag`, { headers: { Authorization: "Bearer s3cret-header" } }));
    const module = mcpModule({ store, fetch: fake.fetch as typeof fetch });
    const { gateway, agent } = await governed({ localMcpMode: "allow" }, module);

    await (await agent.startSession()).send("Hi");
    await (await agent.startSession()).send("Again"); // the same connection: no second report

    const sent = gateway.reported.filter((e) => e["type"] === "local_mcp.attached");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ label: "notes", url: new URL(fake.urls.both).origin + new URL(fake.urls.both).pathname });
    expect(sent[0]!["tools"]).toEqual(expect.arrayContaining(["echo"]));
    expect(JSON.stringify(gateway.reported)).not.toContain("s3cret");
  });
});
