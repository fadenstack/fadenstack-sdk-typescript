# Fadenstack TypeScript SDK

Agents that run in a browser, a web page or Node and are governed by a [Fadenstack](https://fadenstack.com)
server. The SDK runs the agent loop on the device: tools, approvals and the conversation itself. The server owns
the agent's instructions, model and knowledge, and handles personal data, rate limits and audit. Agents need a Fadenstack server 0.4.2 or later.

**Documentation: [developers.fadenstack.com/sdk/typescript](https://developers.fadenstack.com/sdk/typescript/)**
(the source is in [`docs/`](docs/)).

| Package | What it is | .NET |
|---|---|---|
| `@fadenstack/client` | The server connection: the gateway's chat completions (streamed, with the gateway's events), agent sign-in, the agent resource, tool classes and modes, typed errors | `Fadenstack.Client` |
| `@fadenstack/agents` | The agent: the builder, the tool loop, approvals, sessions on the device, outcomes, stages and modules | `Fadenstack.Agents` |
| `@fadenstack/ui` | View models for a chat with an agent, with no UI framework | `Fadenstack.UI` |
| `@fadenstack/ui-web` | The web look every skin shares: the stylesheet, icons, the agent's avatar, the panel's browser behaviours | `Fadenstack.UI.Wpf` (its themes) |
| `@fadenstack/ui-react` | The React skin for those view models: a chat panel | `Fadenstack.UI.Wpf` |
| `@fadenstack/ui-vue` | The Vue skin for the same view models: the same chat panel | `Fadenstack.UI.Wpf` |
| `@fadenstack/testing` | A fake Fadenstack server for tests and demos | — |

The packages are ES modules with type declarations, for browsers (Chrome 116 or later) and Node.js 24 or later.
They use `fetch`, Web Streams, Web Crypto and `AbortSignal` (plus IndexedDB in a browser) and nothing else; the UI
packages add `marked`, and React or Vue.

## An agent

```ts
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, defineTool } from "@fadenstack/agents";

const serverUrl = "https://ai.example.internal";

const readTicket = defineTool<{ id: string }>({
  name: "read_ticket",
  description: "Reads a support ticket by its id.",
  toolClass: "read",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: ({ id }) => `Ticket ${id}: the printer on floor 2 jams on A3 paper.`,
});

const { client, tokens } = FadenstackClient.forAgent({ serverUrl, agent: "my-assistant" });
if (!(await tokens.isSignedIn())) {
  const login = await loginWithPassword({
    apiUrl: serverUrl,
    email: process.env.FADEN_EMAIL ?? "",
    password: process.env.FADEN_PASSWORD ?? "",
  });
  await tokens.signIn(login, "Ticket script"); // the login token is not kept
}

const agent = FadenstackAgent.createBuilder().useClient(client).addTools(readTicket).build();
const session = await agent.startSession(); // starts in "ask"
for await (const event of session.stream("What is ticket T-1042 about?")) {
  if (event.type === "text") process.stdout.write(event.text);
  if (event.type === "turn_completed") console.log(`\n(${event.result.outcome})`);
}
```

A read tool runs without asking. A tool that changes something asks the user first, and without an approval
handler the SDK declines it. A tool that cannot be undone, a tool nobody classified, and a call an administrator's
rule asks about ask every time. The docs cover [tools and approvals](docs/tools.md), [outcomes and errors](docs/outcomes.md),
[sessions on the device](docs/sessions.md), [the chat panel](docs/chat-panel.md) and
[testing without a server](docs/testing.md).

## Install

```bash
npm install @fadenstack/client @fadenstack/agents
```

Add `@fadenstack/ui`, `@fadenstack/ui-web` and `@fadenstack/ui-react` or `@fadenstack/ui-vue` for the chat panel, and
`@fadenstack/testing` for tests.
[Install](docs/index.md#install) also shows how to build from source.

## Build and test

```bash
npm install
npm test            # vitest, against the sources
npm run typecheck
npm run build       # each package's dist/
```

To preview the documentation on its own: `pip install zensical`, then `zensical serve` in this folder.

## Contributing

Questions, bug reports and ideas go in [GitHub issues](https://github.com/fadenstack/fadenstack-sdk-typescript/issues); pick the
template that fits. Please open an issue before you write code for a change, so we can agree on it first.
[CONTRIBUTING.md](CONTRIBUTING.md) says what a pull request needs, including the one-time
[contributor licence agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md) you sign from your first pull request. Everyone
follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report a security problem privately, as [SECURITY.md](SECURITY.md)
describes.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).
