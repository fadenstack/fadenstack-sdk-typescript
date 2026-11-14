import { describe, expect, it } from "vitest";

import { McpConfigError, McpServerState, parseMcpConfig, mcpModule, MemoryMcpServerStore } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";
import { ask, standalone } from "./rig.js";

const CLAUDE_DESKTOP = JSON.stringify({
  mcpServers: {
    notes: { url: "https://mcp.example.com/notes", headers: { Authorization: "Bearer abc" } },
    files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users"], env: { TOKEN: "t" } },
    "old-sse": { type: "sse", url: "https://mcp.example.com/sse" },
  },
});

const VS_CODE = `{
  // VS Code's mcp.json, with a comment and a trailing comma
  "inputs": [{ "id": "key", "type": "promptString" }],
  "servers": {
    "docs": { "type": "http", "url": "https://docs.example.com/mcp", "headers": { "X-Api-Key": "\${input:key}", "X-Team": "red" } },
    "local-tool": { "type": "stdio", "command": "uvx", "args": ["mcp-server-time"] },
    "lan": { "type": "http", "url": "http://localhost:3001/mcp" },
  }
}`;

/** sdk/51 F05, "Import": paste a JSON config; HTTP servers come in off, stdio ones are listed as not possible in a browser. */
describe("importing a pasted configuration", () => {
  it("reads the mcpServers shape: HTTP comes in, a program and the old SSE transport are listed as skipped", () => {
    const result = parseMcpConfig(CLAUDE_DESKTOP);

    expect(result.shape).toBe("mcpServers");
    expect(result.servers).toEqual([{
      label: "notes", url: "https://mcp.example.com/notes", headers: { Authorization: "Bearer abc" },
      enabled: false, trusted: false, toolClasses: {}, reviewed: false, importedFrom: "mcpServers",
    }]);
    expect(result.skipped).toEqual([
      { label: "files", kind: "stdio", reason: "It starts a program on this computer, which a browser cannot do." },
      { label: "old-sse", kind: "sse", reason: "It uses the old SSE transport, which this app does not support." },
    ]);
  });

  it("reads VS Code's servers shape with its type, comments and trailing commas, and leaves out a placeholder header", () => {
    const result = parseMcpConfig(VS_CODE);

    expect(result.shape).toBe("servers");
    expect(result.servers.map((s) => [s.label, s.url, s.headers, s.importedFrom])).toEqual([
      ["docs", "https://docs.example.com/mcp", { "X-Team": "red" }, "servers"],
      ["lan", "http://localhost:3001/mcp", {}, "servers"],
    ]);
    expect(result.skipped).toEqual([{ label: "local-tool", kind: "stdio", reason: expect.stringContaining("a browser cannot do") }]);
    expect(result.notes).toEqual(["docs: the header 'X-Api-Key' was left out (its value is a placeholder this app cannot fill; add it by hand)."]);
  });

  it("reads VS Code's settings.json form, mcp.servers", () => {
    const result = parseMcpConfig('{"editor.fontSize":12,"mcp":{"servers":{"a":{"url":"https://a.example.com/mcp"}}}}');
    expect(result.shape).toBe("mcp.servers");
    expect(result.servers.map((s) => s.label)).toEqual(["a"]);
  });

  it("brings every server in off and not reviewed, whatever the other app said", () => {
    const result = parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: "https://a.example.com/", disabled: false, enabled: true, trusted: true, alwaysAllow: ["x"] } } }));
    expect(result.servers[0]).toMatchObject({ enabled: false, reviewed: false, trusted: false, toolClasses: {} });
  });

  it("skips what is not usable, with a reason, and never puts a header value in it", () => {
    const result = parseMcpConfig(JSON.stringify({
      mcpServers: {
        "no url": { type: "http" },
        "bad url": { url: "not a url" },
        plain: { url: "http://mcp.example.com/", headers: { Authorization: "Bearer topsecret" } },
        creds: { url: "https://user:pw@mcp.example.com/" },
        weird: { type: "carrier-pigeon", url: "https://a.example.com/" },
        "bad name!": { url: "https://a.example.com/" },
        number: 7,
      },
    }));

    expect(result.servers).toEqual([]);
    expect(result.skipped.map((s) => [s.label, s.kind])).toEqual([
      ["no url", "invalid"], ["bad url", "invalid"], ["plain", "invalid"], ["creds", "invalid"], ["weird", "invalid"], ["bad name!", "invalid"], ["number", "invalid"],
    ]);
    expect(JSON.stringify(result)).not.toContain("topsecret");
  });

  it.each([
    ["", /nothing to import/],
    ["   ", /nothing to import/],
    ["not json", /not JSON/],
    ["[1,2]", /no 'mcpServers' or 'servers'/],
    ['{"other": {}}', /no 'mcpServers' or 'servers'/],
    [`{"mcpServers":{}}${" ".repeat(300 * 1024)}`, /too long/],
  ])("refuses %j with a typed error", (text, message) => {
    expect(() => parseMcpConfig(text)).toThrow(McpConfigError);
    expect(() => parseMcpConfig(text)).toThrow(message);
  });

  it("keeps the first of two entries with the same label without regard to case", () => {
    const result = parseMcpConfig('{"mcpServers":{"Notes":{"url":"https://a.example.com/"},"notes":{"url":"https://b.example.com/"}}}');
    expect(result.servers.map((s) => s.url)).toEqual(["https://a.example.com/"]);
    expect(result.skipped).toEqual([{ label: "notes", kind: "invalid", reason: "Another entry has the same label." }]);
  });

  it("reads at most 100 servers", () => {
    const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`s${i}`, { url: "https://a.example.com/" }]));
    const result = parseMcpConfig(JSON.stringify({ mcpServers: many }));
    expect(result.servers).toHaveLength(100);
    expect(result.notes).toEqual(["Only the first 100 servers were read."]);
  });
});

describe("importing into the person's list", () => {
  it("keeps the HTTP servers off, leaves a label the list has, and contacts nothing until the person switches one on", async () => {
    const fake = new FakeMcpServer();
    const rig = standalone(fake);
    await rig.module.add({ label: "Notes", url: fake.urls.legacy, enabled: true });

    const outcome = await rig.module.importConfig(JSON.stringify({ mcpServers: {
      notes: { url: fake.urls.both }, // the label exists (without regard to case)
      docs: { url: fake.urls.both, headers: { "X-Team": "red" } },
      tool: { command: "uvx" },
    } }));

    expect(outcome.added).toEqual(["docs"]);
    expect(outcome.existing).toEqual(["notes"]);
    expect(outcome.skipped.map((s) => s.kind)).toEqual(["stdio"]);
    const kept = await rig.module.servers();
    expect(kept.map((s) => [s.label, s.enabled, s.reviewed])).toEqual([["Notes", true, true], ["docs", false, false]]);
    expect(kept.find((s) => s.label === "Notes")!.url).toBe(fake.urls.legacy); // the existing one was not replaced

    await ask(rig, "Hi");
    expect(Object.fromEntries(rig.module.statuses.map((s) => [s.label, s.state]))).toEqual({ docs: McpServerState.Off, Notes: McpServerState.Running });
    expect(fake.seen.every((s) => s.path === "/legacy")).toBe(true); // the imported one was never contacted
  });

  it("refuses without a store", async () => {
    await expect(mcpModule({ store: false }).importConfig(CLAUDE_DESKTOP)).rejects.toThrow(/keeps no list/);
    const memory = new MemoryMcpServerStore();
    await expect(mcpModule({ store: memory }).importConfig("nope")).rejects.toThrow(McpConfigError);
  });
});
