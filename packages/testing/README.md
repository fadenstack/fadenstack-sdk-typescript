# @fadenstack/testing

A fake [Fadenstack](https://fadenstack.com) server with a scripted model, for tests and demos. `FakeGateway`
answers the routes an agent uses (sign-in, agent tokens, the profile, chat completions with the server's events,
event reports and approvals) and checks what the real server checks: tokens, grants, the agent's contract and the
fields of reported events. A mistake in your integration shows in a test before it shows against a server.

```bash
npm install --save-dev @fadenstack/testing
```

```ts
import { FakeGateway, lastToolResults } from "@fadenstack/testing";

const gateway = new FakeGateway({
  agents: [{ slug: "docs-assistant", contract: [{ name: "read_page", risk: "read" }] }],
  model: (request) => lastToolResults(request).size
    ? { text: "Page 7 shows table T1." }
    : { toolCalls: [{ name: "read_page", arguments: { page: 7 } }] },
});

// Pass gateway.serverUrl and gateway.fetch to FadenstackClient.forAgent and loginWithPassword.
```

The gateway answers in the same process through its own `fetch`, or over HTTP with `listen()` in Node.

To run a tool by hand, `toolContext()` makes its `ToolCallContext`; `@fadenstack/testing/provenance` adds a
pass-through `Provenance` for tools that place content (`toolContext({ services: provenanceServices() })`).

- Documentation: <https://developers.fadenstack.com/sdk/typescript/testing/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
