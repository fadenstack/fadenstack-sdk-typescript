# TypeScript SDK

Build agents that run in a browser, a web page or Node and are governed by a Fadenstack server.

!!! note "Server version"
    Agents need a Fadenstack server 0.4.2 or later. With 0.4.1 and older, only
    [plain chat completions](plain-api.md) work, without tool modes, rules and the gateway's events.

## What the SDK does

The SDK runs the agent loop on the device. It sends the conversation to the server, runs the tools your application
provides, asks the user before a tool changes something, and keeps the conversation on the device.

The server owns the parts that should not live in your application: the agent's instructions, its model and its
knowledge. It also handles personal data (PII), rate limits and the audit record. Budgets are
<span class="fs-planned">Planned</span>.

You register an agent on the server first, and your application then signs in to it on behalf of a user. See
[Agents](../../concepts/agents.md) for what the server keeps about an agent, and
[Your first agent](../../get-started/first-agent.md) to register one.

The SDK also powers Fadenstack's browser agent.

## Packages

| Package | What it is | .NET |
|---|---|---|
| `@fadenstack/client` | The server connection: the gateway's chat completions (streamed, with the gateway's events), agent sign-in, the agent resource (profile, event reports, approvals), tool classes and modes, typed errors | `Faden.Client` |
| `@fadenstack/agents` | The agent: the builder, the tool loop, tool classes and modes, approvals, sessions on the device, outcomes, stages and modules | `Faden.Agents` |
| `@fadenstack/ui` | View models for a chat with an agent, with no UI framework | `Faden.UI` |
| `@fadenstack/ui-react` | The React skin for those view models: a chat panel | `Faden.UI.Wpf` |
| `@fadenstack/testing` | A fake Fadenstack server for tests and demos | — |

The packages follow the [.NET SDK](../dotnet/index.md): the same concepts, the same tool classes and modes, and the
same transcript format for sessions.

## Runtimes

- Browsers: Chrome 116 or later, in a web page or a browser extension.
- Node.js 20.19 or later.

The packages are ES modules with type declarations. They use standard web APIs only: `fetch`, Web Streams, Web Crypto
and `AbortSignal`, plus IndexedDB in a browser for sessions.

The client talks to a server over HTTPS. It refuses an `http://` address unless you set `allowInsecureHttp`, which is
meant for a development server on your own machine. Sign-in, `loginWithPassword`, `listModels` and `createAgent`
send a password or a token: they refuse `http://` to another machine unless you set `allowInsecureHttp` for them
too, and allow it to this machine (`localhost`, `127.0.0.1`, `::1`).

## Dependencies

| Package | Depends on |
|---|---|
| `@fadenstack/client` | Nothing |
| `@fadenstack/agents` | `@fadenstack/client` |
| `@fadenstack/ui` | `@fadenstack/agents`, `@fadenstack/client`, and `marked` for Markdown |
| `@fadenstack/ui-react` | The three packages above, with React and React DOM 18.2 or later as peer dependencies |
| `@fadenstack/testing` | `@fadenstack/client` |

## Install

Install the packages you need from npm, by name:

```bash
npm install @fadenstack/client @fadenstack/agents
```

Add `@fadenstack/ui` and `@fadenstack/ui-react` for the chat panel. Add `@fadenstack/testing` as a development
dependency for [testing without a server](testing.md). The packages are released together, with one version; keep them
on the same version.

### From source

To try changes that are not released yet, build the packages from source and add them to your project. You need
Node.js 20.19 or later and git:

```bash
git clone https://github.com/fadenstack/fadenstack-sdk-typescript.git
cd fadenstack-sdk-typescript
npm install
npm run build
```

Then add the packages you need to your project, in one of two ways.

=== "Packed files"

    Pack each package into a `.tgz` file and install the files. Your project gets its own copy, as it would from npm.

    ```bash
    # in fadenstack-sdk-typescript
    mkdir ../fadenstack-packages
    npm pack --workspaces --pack-destination ../fadenstack-packages

    # in your project
    npm install ../fadenstack-packages/fadenstack-client-0.1.0.tgz ../fadenstack-packages/fadenstack-agents-0.1.0.tgz
    ```

    Install packages that depend on each other in one command. npm then finds `@fadenstack/client` among the files
    instead of looking for it on npm.

=== "Linked folders"

    Install the package folders. npm links them, so your project picks up the next `npm run build` in the SDK without
    installing again.

    ```bash
    # in your project
    npm install ../fadenstack-sdk-typescript/packages/client ../fadenstack-sdk-typescript/packages/agents
    ```

    Linked packages resolve their own imports from the SDK's `node_modules`. If you link `@fadenstack/ui-react`, make
    your bundler use a single copy of React, for example with Vite's `resolve.dedupe`.

## A complete example

This Node script signs in to the agent `my-assistant`, gives it one tool, and prints the answer as it streams. It
reads the user's e-mail and password from the environment.

```ts
import { FadenClient, loginWithPassword } from "@fadenstack/client";
import { FadenAgent, defineTool } from "@fadenstack/agents";

const serverUrl = "https://ai.example.internal";

// A host tool: something your application can do for the agent.
const readTicket = defineTool<{ id: string }>({
  name: "read_ticket",
  description: "Reads a support ticket by its id.",
  toolClass: "read",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The ticket id, e.g. T-1042." } },
    required: ["id"],
  },
  run: ({ id }) => `Ticket ${id}: the printer on floor 2 jams on A3 paper.`,
});

// A client for one agent. Here the sign-in is kept in memory, for as long as the process runs.
const { client, tokens } = FadenClient.forAgent({ serverUrl, agent: "my-assistant" });
if (!(await tokens.isSignedIn())) {
  const login = await loginWithPassword({
    apiUrl: serverUrl,
    email: process.env.FADEN_EMAIL ?? "",
    password: process.env.FADEN_PASSWORD ?? "",
  });
  await tokens.signIn(login, "Ticket script");
}

const agent = FadenAgent.createBuilder().useClient(client).addTools(readTicket).build();

const session = await agent.startSession();
for await (const event of session.stream("What is ticket T-1042 about?")) {
  if (event.type === "text") process.stdout.write(event.text);
  if (event.type === "turn_completed") console.log(`\n(${event.result.outcome})`);
}
```

`read_ticket` only reads, so it runs without asking. A tool that changes something asks first, and without an
approval handler the SDK declines it. See [Tools and approvals](tools.md).

## Where next

- [Build an agent](agent.md): the client, signing in, the builder, sessions and streaming.
- [Tools and approvals](tools.md): host tools, tool classes, tool modes and approvals.
- [Outcomes and errors](outcomes.md): how a turn ends, and what is thrown.
- [Sessions on the device](sessions.md): where conversations are kept, and for how long.
- [The chat panel](chat-panel.md): a ready-made chat UI for React, and view models for other frameworks.
- [Testing without a server](testing.md): the fake server in `@fadenstack/testing`.
- [Plain chat completions](plain-api.md): the gateway's chat without an agent.
