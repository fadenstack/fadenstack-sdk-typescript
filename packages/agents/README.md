# @fadenstack/agents

Agents that run in a browser, a web page or Node and are governed by a [Fadenstack](https://fadenstack.com)
server. This package runs the agent loop on the device: your tools, approvals, tool modes and the conversation.
The server owns the agent's instructions, model and knowledge, and handles personal data, rate limits and audit.

```bash
npm install @fadenstack/client @fadenstack/agents
```

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
const session = await agent.startSession(); // the agent's default level: "ask" unless set otherwise
for await (const event of session.stream("What is ticket T-1042 about?")) {
  if (event.type === "text") process.stdout.write(event.text);
}
```

A read tool runs without asking. A tool that changes something asks the user first, and without an approval
handler the SDK declines it. The agent `my-assistant` is registered on the server first.

Approvals can be given more time. Where the server holds grants, a person can allow a tool for a while or a stretch of
work in some places, and switch approvals off in one conversation (Bypass) after signing in again in the browser:
`agent.grants` and `session.startBypass()` do it on the same wire as the .NET SDK, and the app gives
`useStepUpHandler(...)` to open that second sign-in -- Bypass is announced to the server, and so offered, only with
it. Chats and "Allow always" are kept per signed-in user, so two people in one browser profile never see each other's;
`agent.listApprovals()` lists what a person allowed always. See
[Server-held grants and Bypass](https://developers.fadenstack.com/sdk/typescript/server-grants/).

Related packages: [`@fadenstack/ui`](https://www.npmjs.com/package/@fadenstack/ui) and
[`@fadenstack/ui-react`](https://www.npmjs.com/package/@fadenstack/ui-react) for a chat panel,
[`@fadenstack/testing`](https://www.npmjs.com/package/@fadenstack/testing) for tests without a server.

The package is an ES module with type declarations, for browsers (Chrome 116 or later) and Node.js 24 or later. It needs a Fadenstack server 0.4.2 or later.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
