# Local MCP servers

This page covers how an agent uses the person's own MCP servers with `@fadenstack/mcp`:
- adding them;
- where they may be reached;
- when they are attached;
- the class of their tools;
- the Tools view.

The .NET SDK has the same module, `Fadenstack.Mcp` ([.NET: Local MCP servers](../dotnet/local-mcp.md)). It also starts programs on the device and scans for servers.

## A browser reaches servers over HTTP

A browser page or an extension cannot start a process, so this module speaks to MCP servers over HTTP only (Streamable HTTP; MCP 2026-07-28, falling back to 2025-11-25). There is no stdio server and no scan. A server must answer the browser's CORS checks:
- it allows the headers `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `Mcp-Session-Id`;
- it exposes `Mcp-Session-Id`.

Many servers built for stdio do not, and then a browser session breaks.

**No program, so no program pin.** Because this module starts no program, it has nothing to pin: the .NET SDK pins the file a local server starts (its path and SHA-256), checks it before every start, and does not start a program that changed until the person says so ([.NET: The program is pinned](../dotnet/local-mcp.md#the-program-is-pinned)). A server over HTTP has no program file the SDK could check, and it is not listed in the manifest's device block either ([What your app reports about the device](tools.md#what-your-app-reports-about-the-device)).

## Add the module

```ts
import { mcpModule } from "@fadenstack/mcp";

const mcp = mcpModule({
  servers: [{ label: "Docs", url: "https://mcp.example.com/mcp" }], // the app's own, always on, never stored
});
const agent = FadenstackAgent.createBuilder().useEndpoint(endpoint).useLocalProfile(definition).use(mcp).build();
```

**The person's own servers** live in IndexedDB, one database per principal (`fadenstack-mcp`). Standalone is its own principal, and `deleteMyData` removes them (with the person's other shared data, when no other Fadenstack app in the browser uses it, or with `scope: "allApps"`). A header value (a token) is sealed with the principal's WebCrypto key. [Data on the device](data-on-device.md) lists it with the SDK's other databases.

**One list in several contexts** (a side panel and a service worker, two tabs): each server is its own record, so one context's change never overwrites another's, and the label check and the write are one transaction. A change is told to the other contexts of the origin over a `BroadcastChannel` (`MCP_STORE_CHANNEL`; the message carries the database's name, nothing else), so their module asks again and a Tools view reads the list; `broadcast: false` turns that off. .NET does the same for several apps on one file (`McpHost`).

The person's list (`McpModule`):

| Member | Meaning |
|---|---|
| `servers()` | The servers as kept. |
| `add(server)` | Adds or replaces a server. `checkServer` throws `McpConfigError` for one that breaks a rule. |
| `remove(label)` | Removes a server. |
| `setEnabled(label, on)` | Switches a server on or off. Switching it on is the person's review: an imported server arrives off. |
| `setTrusted(label, trusted)` | The person's word that the server's hints are true (see below). |
| `setToolClass(label, tool, raise)` | The person raises one tool to `read` or `write`, or takes the raise back. |
| `setPlainHttpInLan(label, on, warningVersion)` | The switch "Allow plain http on the local network" (see below). |
| `importConfig(text)` | Reads a pasted configuration (see below). |
| `statuses`, `onStatusChanged` | What runs, what failed and what was refused, with the reason. |

The person's list reaches the agent at the start of its next turn.

## Where a server may be reached

- **https** goes anywhere.
- **Plain http to this computer** (`localhost`, 127.0.0.0/8, `::1`) is fine. A header value goes over plain http only to `localhost`, `127.0.0.1` or `::1` exactly, as for an endpoint's key ([Standalone mode](standalone.md#keys)).
- **Plain http to the local network** goes only when all of these hold:
  - the server's switch "Allow plain http on the local network" is on;
  - the agent's profile says `local_mcp.plain_http: allow` (absent or anything else is deny, and developer mode does not override it);
  - this computer's policy does not say `plainHttp: forbidden`;
  - the server is sent no header value.
- **Anything else** is refused before anything is sent.

A browser cannot resolve names, so the host's spelling decides (`hostScope`). These count as the local network:
- an RFC 1918, link-local or fc00::/7 address;
- a single-label name;
- a name ending in `.local`, `.lan`, `.home.arpa` or `.internal`.

A name that merely looks local can point anywhere. That is why the switch is the person's, behind a warning, and https stays the way beyond this computer. The .NET SDK resolves the name instead and holds the connection to the checked address.

**A refusal** is in the server's status: `notAllowed`, with `plainHttp` set to one of these:
- `noOptIn`: the switch is off;
- `notLocal`: the host is not on the local network;
- `secret`: a header value;
- `notAllowed`: the profile or the policy, shown as "Plain http is not allowed here".

It is not retried, and a connection the rule no longer allows stops at the next turn.

**`checkServer`** keeps a plain-http server on the local network with the switch off, to wait for it. It refuses one with a header value (`McpConfigError.problem` `plainHttpWithHeaders`) or one outside the local network (`plainHttpNotLocal`).

### The switch

`setPlainHttpInLan(label, true, warningVersion)` needs the version of the warning the person confirmed just before. The app shows the warning; the Tools view below does it for you. Turning it off needs no warning.

Every change goes into the device's audit log, which never leaves the device. It is kept with the person's servers (`store.audit()`, the newest 500, deleted with their data). Each line holds:
- the event `local_mcp.plain_http`;
- the time;
- the server's origin only (no path, query or token);
- on or off;
- the warning's version;
- the person.

In governed mode the change goes to the server as `local_mcp.plain_http {source, state}`. That happens only where the profile's `features` list `client_events.local_mcp_plain_http` (`PLAIN_HTTP_EVENT_FEATURE`), because an older core refuses a batch with a type it does not know. Standalone sends nothing.

## When servers are attached

A server is attached at the start of a turn when its policy allows it (`coreLocalMcpPolicy` by default):
- **Governed:** the agent's `local_mcp.mode` is `allow`, or the person has developer mode.
- **Standalone:** the person's setting, under this computer's policy. The policy's `mcp` key forbids local MCP servers, or lists the sources allowed. A source is the server's address or origin, never its label, which is the person's own word ([Machine policy](machine-policy.md)).

A server that cannot be reached, or does not list its tools within the connect timeout (`connectTimeoutMs`, 30 s), is skipped. The agent runs without it.

## The class of a tool

- **An MCP tool arrives unclassified, so it asks** every time in `ask` and `auto`; it is hidden in `readOnly` and `off`.
- **A `destructiveHint` from any server makes the tool destructive,** and nothing lowers that.
- **A `readOnlyHint` counts only from a trusted server.**
  - Standalone: the person marks it (`setTrusted`).
  - Governed: the administrator's list (`trustedServers`) decides, and the person's mark means nothing.
- **The person may raise a single tool** to read or write (`setToolClass`), never below a destructive hint.

In governed mode the agent's contract then makes a class stricter and drops what it does not list.

## Tools on request

While a server is attached, the model gets one tool, `find_tool`, whose description lists the servers. A search switches the best matches on for the rest of that conversation. Results are fenced as untrusted data. [Local tools](local-tools.md) describes tools on request.

## Import a configuration

`importConfig(text)` reads a pasted configuration:
- `mcpServers`, as Claude Desktop, Cursor and others write it;
- VS Code's `servers`, or the `mcp.servers` of its settings.

**HTTP servers come in off and not reviewed.** **Left out, each with its reason:**
- a server that starts a program (`stdio`);
- one on the old SSE transport (`sse`);
- one on plain http beyond this computer (`plainHttp`; the person adds it by hand and turns its switch on);
- one that breaks a rule.

An import never sets the switch or the trust mark. A header value that is a placeholder (`${...}`) is left out, with a note.

## The Tools view

`@fadenstack/ui` has the view models; `@fadenstack/ui-react` and `@fadenstack/ui-vue` draw them as `ToolsPage`:

```ts
import { McpToolsCatalog, agentToolsView } from "@fadenstack/mcp";
import { ToolsPageViewModel } from "@fadenstack/ui";

const tools = new ToolsPageViewModel({ catalog: new McpToolsCatalog(mcp, agentToolsView(agent)) });
// React: <ToolsPage tools={tools} />   Vue: <ToolsPage :tools="tools" />
```

**One page, up to three tabs**, in this order:
- "In this app": the tools the app itself gives the assistant (its own `host` tools, not MCP, server or SDK built-in tools), read only: name, class and a short description;
- "On this computer" (the default): the person's servers; Add, the paste import and the policy chip are on this tab only;
- "On your server": the organisation's tools, read only. It is shown in governed mode only (`LocalToolsCatalog.governed`): standalone, or while the connection is not known, there is no such tab and the cloud tools are not loaded.

The chat's settings item "Tools" opens this page when you pass `openTools` to the chat's options (the settings close, then your function shows the page); without it the item opens the chat's read-only Tools panel.

**What it shows:**
- the policy;
- the person's servers as cards, with status, on/off and "not reviewed";
- the details:
  - the trust mark;
  - each tool's class and the person's raise;
  - under *Advanced*, the plain-http switch;
- the add and edit sheet, with header values in password fields: a saved value is never shown back, only dots and *Replace*;
- the paste import;
- "In this app", and in governed mode "On your server": read only lists.

**The switch** shows only where it applies and is allowed. Turning it on opens the warning (version `2026-11-15`) and changes nothing until the person presses *Allow*. Each refusal has its own words.

The texts are in English, German, French, Spanish and Simplified Chinese. The contract (`LocalToolsCatalog`) is in `@fadenstack/agents`, so `@fadenstack/ui` does not depend on the module.

## What the server learns

In governed mode the server learns the switch's changes as above, and each attached server once per connection as `local_mcp.attached`: its label, its address without a user, password, query or fragment, and its tools' names, as the .NET SDK sends it. Standalone, nothing goes anywhere. A header value is never reported or logged; the log has labels, kinds and counts only.

OWASP ASVS 5.0: V12 (secure communication), V13 (configuration and secrets), V15 (secure coding).
