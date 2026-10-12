# @fadenstack/client

The connection to a [Fadenstack](https://fadenstack.com) server: the gateway's chat completions (streamed, with
the gateway's events), agent sign-in, the agent resource, tool classes and modes, and typed errors.

Most applications want an agent: add [`@fadenstack/agents`](https://www.npmjs.com/package/@fadenstack/agents),
which builds on this package. Use this package on its own to call the gateway without an agent.

```bash
npm install @fadenstack/client
```

```ts
import { FadenClient, StaticTokenProvider } from "@fadenstack/client";

const client = new FadenClient({
  serverUrl: "https://ai.example.internal",
  credentials: new StaticTokenProvider(process.env.FADEN_API_TOKEN ?? ""),
  model: "my-model",
});

const response = await client.chat.complete([{ role: "user", content: "What does a heat exchanger do?" }]);
console.log(response.refused ? `Refused: ${response.refused.message}` : response.text);
```

The server's policies apply to every call. The package is an ES module with type declarations, for browsers
(Chrome 116 or later) and Node.js 20.19 or later, and has no dependencies. It needs a Fadenstack server 0.4.2 or
later.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
