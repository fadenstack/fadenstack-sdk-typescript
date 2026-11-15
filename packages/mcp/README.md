# @fadenstack/mcp

Local MCP servers over HTTP for a [Fadenstack](https://fadenstack.com) agent: the person's servers (an address and headers) become the agent's
tools under the SDK's rules. A browser cannot start a program, so there are no stdio servers and no scan; the .NET SDK's `Fadenstack.Mcp` does both.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/mcp
```

```ts
import { FadenstackAgent } from "@fadenstack/agents";
import { mcpModule } from "@fadenstack/mcp";

const mcp = mcpModule();            // the person's servers: IndexedDB per principal, header values sealed with their key
const agent = FadenstackAgent.createBuilder().useClient(client).useAgent("browser-assistant").use(mcp).build();

await mcp.importConfig(pastedJson); // an `mcpServers` or VS Code `servers` configuration: everything arrives off
await mcp.setEnabled("notes", true);
```

- The client is `@modelcontextprotocol/client` 2.4.0 with `versionNegotiation: { mode: 'auto' }`: MCP 2026-07-28, falling back to 2025-11-25.
- A tool arrives unclassified, so it asks. `destructiveHint: true` makes it destructive; a `readOnlyHint` counts only from a server the person (or, with a
  server, the administrator: `trustedServers`) marked trusted; only they raise a tool to read or write.
- Governed: the profile's `local_mcp.mode`. Standalone: the person's setting, under the machine policy's `mcp`.
- A server must answer CORS requests that carry `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `Mcp-Session-Id`.
