# Plain chat completions

Call the gateway's chat completions directly, without an agent, with an API token.

An agent is usually what you want: the server owns its instructions, model and tool contract, and the SDK runs its
tools. Without an agent, the client calls the plain `/v1/chat/completions` route. You pick the model, write the
messages, and run any tool calls yourself. The server's policies still apply, and a refusal arrives as part of the
answer. See [Chat completions](../../api/chat-completions.md) for the API itself.

## The client without an agent

Create a `FadenClient` with an API token and a model:

```ts
import { FadenClient, StaticTokenProvider } from "@fadenstack/client";

const client = new FadenClient({
  serverUrl: "https://ai.example.internal",
  credentials: new StaticTokenProvider(process.env.FADEN_API_TOKEN ?? ""),
  model: "my-model", // a model the server offers
});
```

`StaticTokenProvider` sends the same token with every request. It throws a `TypeError` for an empty token.

| Option | What it is |
|---|---|
| `serverUrl` | The Fadenstack server. Required. |
| `credentials` | Where access tokens come from: a `StaticTokenProvider` with an API token, or an agent sign-in. |
| `model` | The model for the plain routes. An agent's model is the agent's, whatever this says. |
| `agent` | The agent's slug or id. With it, chat goes to the agent's route instead; `FadenClient.forAgent` sets it. |
| `toolMode` | The tool mode sent with each request, unless a request says otherwise. Default `ask`. |
| `gatewayEvents` | Whether to ask the gateway for its events: tool rounds, approvals, notices. Default on. |
| `apiUrl` | The server's backend for sign-in, when it is not at `serverUrl`. |
| `fetch` | The `fetch` to use. The global one by default. |
| `timeoutMs` | How long one request may take, in milliseconds. The default is five minutes. A streamed answer that has started is not cut off by it. |
| `allowInsecureHttp` | Allows an `http://` address. Only for a development server on your own machine. |

`client.getFeatures()` returns the server's edition and features (`GET /v1/features`, on a server 0.4.2 or
later).

## A whole answer

`client.chat.complete(messages, options?)` returns the whole answer at once:

```ts
const response = await client.chat.complete([
  { role: "system", content: "Answer in one sentence." },
  { role: "user", content: "What does a heat exchanger do?" },
]);

if (response.refused) console.log(`Refused: ${response.refused.message}`);
else console.log(response.text);
```

The `ChatResponse`:

| Field | What it is |
|---|---|
| `text` | The answer. |
| `reasoning` | The model's reasoning, for models that report it. Empty otherwise. |
| `toolCalls` | The tool calls the model made. |
| `finishReason` | `stop`, `length`, `tool_calls`, `content_filter`, or another value the model gives. |
| `usage` | `promptTokens`, `completionTokens`, `totalTokens`, and `cachedPromptTokens` when the server reports it. |
| `events` | The gateway's events for the request. |
| `refused` | Set when the gateway refused the prompt or stopped the answer: a notice with the `outcome` and the `message` to show. |
| `id`, `model` | The response's id and the model that answered. |

A refusal is an answer, not an error: `refused` is set and `finishReason` is `content_filter`. Only real failures
throw. See [Outcomes and errors](outcomes.md#errors).

## A streamed answer

`client.chat.stream(messages, options?)` yields the answer as it streams:

```ts
for await (const update of client.chat.stream(messages, { temperature: 0.2 })) {
  switch (update.type) {
    case "text": process.stdout.write(update.text); break;
    case "refused": console.log(`\nRefused: ${update.notice.message}`); break;
    case "finish": console.log(`\n(${update.reason})`); break;
  }
}
```

| `type` | Fields | What it is |
|---|---|---|
| `text` | `text` | A piece of the answer. |
| `reasoning` | `text` | A piece of the model's reasoning. |
| `tool_calls` | `calls` | The tool calls, whole, once the model has written them. |
| `usage` | `usage` | The tokens used. |
| `event` | `event` | One of the gateway's events. |
| `refused` | `notice` | The gateway refused the prompt or stopped the answer. |
| `finish` | `reason`, `responseId`, `model` | The answer ended. |

## Request options

Both methods take `ChatOptions`:

| Option | What it is |
|---|---|
| `model` | The model for this request, instead of the client's. |
| `temperature`, `topP`, `maxTokens`, `seed`, `stop` | Sent as the request fields `temperature`, `top_p`, `max_tokens`, `seed` and `stop`. |
| `reasoningEffort` | How much a reasoning model thinks first: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`. `none` answers at once. |
| `responseFormat` | `{ type: "json_object" }`, or `{ type: "json_schema", name?, schema }` for an answer in a given shape. |
| `tools` | Tools the model may call: `{ name, description?, parameters? }`, with `parameters` as JSON Schema. |
| `toolChoice` | `auto`, `none`, `required`, or `{ name }` for one tool. |
| `toolMode` | The tool mode for this request. |
| `conversationId` | Groups usage per conversation, without the server keeping the conversation. |
| `turnId` | An id for the turn. |
| `sessionId` | A server session, for the plain routes. |
| `skills` | Skills picked by slug for this message. |
| `extra` | More request fields, sent as they are. |
| `signal` | Stops the request. |

## Tool calls

The client gives you the model's tool calls whole: each `ToolCall` has an `id`, a `name`, the arguments as the model
wrote them (`argumentsJson`), and the parsed `arguments`, or `argumentsError` when they are not a JSON object. Running
the tools and sending their results back is up to you: add the model's message with its `tool_calls`, a `tool`
message per result, and call the model again.

An agent does all of this for you, with tool classes, tool modes and approvals. See [Build an agent](agent.md).

## Other routes

`client.transport` makes authenticated requests to other routes, with the same tokens and typed errors:

```ts
const features = await client.transport.get<{ edition: string; features: string[] }>(
  client.transport.gateway("v1/features"),
);
```

`gateway(path)` builds an address under the server, `api(path)` one under the backend. `get`, `post`, `patch`,
`delete` and `json` send JSON and throw a `FadenApiError` for an error status.
