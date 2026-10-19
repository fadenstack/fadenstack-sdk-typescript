# Testing without a server

`@fadenstack/testing` is a fake Fadenstack server with a scripted model, for tests and demos.

The `FakeGateway` answers the routes an agent uses: sign-in, agent tokens, the profile, chat completions with the
server's events, event reports and approvals. It checks what the real server checks (tokens, grants, the agent's
contract, the fields of reported events), so a mistake in your integration shows in a test before it shows against a
server.

## A first test

The gateway answers in the same process, through its own `fetch`. Pass `gateway.fetch` to the client and to
`loginWithPassword`:

```ts
import { expect, it } from "vitest";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";

it("reads the page before it answers", async () => {
  const gateway = new FakeGateway({
    agents: [{ slug: "docs-assistant", contract: [{ name: "read_page", risk: "read" }] }],
    model: (request) => lastToolResults(request).size
      ? { text: "Page 7 shows table T1." }
      : { toolCalls: [{ name: "read_page", arguments: { page: 7 } }] },
  });

  const { client, tokens } = FadenstackClient.forAgent({
    serverUrl: gateway.serverUrl,
    agent: "docs-assistant",
    fetch: gateway.fetch,
  });
  const login = await loginWithPassword({
    apiUrl: gateway.serverUrl,
    email: "user@example.com",
    password: "secret",
    fetch: gateway.fetch,
  });
  await tokens.signIn(login);

  const readPage = defineTool<{ page: number }>({
    name: "read_page",
    toolClass: "read",
    parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    run: ({ page }) => `Page ${page}: table T1, 4 rows`,
  });
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .addTools(readPage)
    .useSessionStore(new MemorySessionStore())
    .build();

  const session = await agent.startSession();
  const result = await session.send("What is on page 7?");

  expect(result.outcome).toBe("completed");
  expect(result.text).toBe("Page 7 shows table T1.");
  expect(gateway.modelCalls).toHaveLength(2);
});
```

The model is called twice: first it asks for `read_page`, then, with the tool's result in the request, it answers.

Without options, the gateway serves one agent, `test-agent`, to one user, `user@example.com` with the password
`secret`, and its model gives the same short answer to every request.

## Options

| Option | What it is |
|---|---|
| `agents` | The agents it serves. Default: one agent, `test-agent`. |
| `users` | The users it knows. Default: `user@example.com` with the password `secret`. |
| `model` | The scripted model. See below. |
| `serverUrl` | The address the in-process `fetch` answers for. Default `https://faden.test`. |
| `accessTtlSeconds` | How long an access token lasts. Default 600. |
| `refreshTtlSeconds` | How long a refresh token lasts. Default 86 400. |
| `chunkSize` | Characters per streamed piece of text. Default 6. |
| `models` | The models `GET /v1/models` lists. Default `["fake-model"]`. |
| `toolRules` | The administrator's tool rules: `[{ pattern, action, message }]`, `action` `deny` or `approval_required`, `*` in a pattern for any characters. As on the server, a denied tool is not offered and a call of it is refused; a call a rule asks about is marked, so the session asks every time. |
| `now` | The clock, for tests of expiry. |
| `provenance` | The provenance module: `{ enabled?, down?, receipts?, policy?, watermark? }`. On by default. `enabled: false` is a server without it (its routes answer 404); `down` is a module whose service is not running (503, and unsigned receipts). With `receipts`, a streamed answer ends with a `faden.provenance` event and a whole one names its receipt in `x-faden-provenance`; off by default, so a turn has only the events you script. `policy` is the server's marking policy, `watermark` what receipts say about the watermark (default: none, the runtime does not watermark). Both verify routes answer from the records signed here: the agent's (`/v1/agents/{agent}/provenance/verify`) and the user's (`/v1/provenance/verify`), which refuses an agent token with 403 `agent_token_not_allowed`, as the gateway does. |

An agent (`FakeAgent`):

| Field | What it is |
|---|---|
| `slug` | The agent's slug. Required. |
| `name`, `id`, `version`, `model` | What the profile says. |
| `contract` | The host tool contract: `[{ name, risk }]`, with `risk` `read`, `write` or `destructive`. Empty: nothing is held back, and every tool is unclassified, so it asks. |
| `ui` | The profile's `ui`, for example `{ greeting, suggestions }`. |
| `ceiling` | A limit on the tool modes, as the profile reports it. |
| `requiredClientModules` | Modules the agent requires. |
| `localMcpMode` | `disable` or `allow`. |
| `provenancePolicy` | The agent's marking policy, over the server's. |

A user (`FakeUser`):

| Field | What it is |
|---|---|
| `email`, `password` | What `loginWithPassword` takes. Required. |
| `id` | The user's id. |
| `agents` | The slugs of the agents granted to the user. All agents when not given. |
| `developerMode` | What the profile reports for local MCP. |
| `createsAgents` | Whether the user may create agents. |
| `language` | The language the user picked for all their clients, in the profile's `user`. |

## Script the model

The model is a function from a `FakeModelRequest` to a `FakeReply`, or a promise of one. It is called for every chat
request. `gateway.setModel(model)` replaces it.

The request has the `agent`, the `messages`, the `tools` the model is offered, whether it is a `stream`, the
`toolMode`, `conversationId` and `turnId` from the request's headers, and the whole `body`. Two helpers read it:

- `lastUserText(request)` is the last user message, attachments included.
- `lastToolResults(request)` maps tool call ids to the results of the tools the model called last. It is empty before
  any tool ran.

A reply can hold:

| Field | What the agent sees |
|---|---|
| `text` | The answer, streamed in pieces. |
| `reasoning` | Reasoning before the answer. |
| `toolCalls` | `[{ name, arguments?, id? }]`: calls of your tools. |
| `events` | Server events sent before the answer, for example citations or a PII notice. |
| `refuse` | `{ stage: "input", message }` refuses the prompt (outcome `prompt_blocked`); `{ stage: "output", message }` stops the answer (outcome `response_blocked`). Optional `decisionId` and `category`. |
| `gatewayTool` | A tool the server runs before the answer: `{ name, arguments?, result? }`. With `approval: { message?, timeoutS?, rule?, toolClass? }`, your approval handler is asked first, with `source` set to `gateway`. Without `rule: false` and a `toolClass`, the call asks every time, as from a server that does not say. |
| `deniedTool` | `{ name, message, callId? }`: the server refuses a tool call. The outcome is `tool_denied`. |
| `rateLimit` | `{ retryAfterS?, code?, message? }`: a 429 instead of an answer. The outcome is `rate_limited`, and the error carries `code`. |
| `streamError` | `{ message, code? }`: the answer breaks off after the text. The turn throws a `FadenstackStreamError`. |
| `finish` | The finish reason in place of `stop` or `tool_calls`, for example `length`: with no text and no tool call, the turn gets an `empty_answer` notice of category `length`. |
| `usage` | `{ prompt, completion }` tokens. |
| `delayMs` | A pause between streamed pieces. |
| `receipt` | With `provenance.receipts` on: `false` sends no receipt for this answer, `{ unsigned: true }` one the server could not sign, `{ watermark }` what it says about the watermark. |

The parts are sent in this order: events, the server tool, reasoning, text, tool calls.

## What it answers, and what it refuses

| Route | What it does |
|---|---|
| `POST /api/auth/jwt/login` | Signs a user in. Wrong credentials: 400 `LOGIN_BAD_CREDENTIALS`. |
| `POST /api/agent-tokens` | Signs a device in to an agent. Without a grant: 403. |
| `POST /api/agent-tokens/refresh` | Renews a sign-in and replaces its refresh token. A refresh token used twice ends the whole sign-in. |
| `POST /api/agents` | Creates an agent, for a user with `createsAgents`. |
| `GET /v1/features`, `GET /v1/models`, `GET /api/health` | The server's edition and features, the models, and health. |
| `GET /v1/agents/{agent}/profile` | The agent's profile. |
| `PATCH /v1/agents/{agent}/user` | Keeps the user's language (`{ "language": tag }`, or `null` to forget it). A value that is not a language tag: 400. |
| `POST /v1/agents/{agent}/chat/completions` | Chat, streamed or whole, with the server's events. |
| `POST /v1/agents/{agent}/events` | Event reports. |
| `PUT /v1/agents/{agent}/manifest` | The app's manifest. |
| `POST /v1/agents/{agent}/approvals/{id}` | The answer to a server tool's approval. |
| `GET /v1/agents/{agent}/provenance/policy` | The agent's marking policy, with the contract's defaults. |
| `POST /v1/agents/{agent}/provenance/records` | Signs a record of a placement, by the content's hash. The signature is a JWS nobody can check. |
| `POST /v1/agents/{agent}/provenance/placements` | A placement report. |
| `GET /v1/provenance/anchors`, `POST /v1/provenance/verify` | The anchors, and a detector that finds content by the records the fake signed. |

Like the real server, it refuses:

- a missing, unknown, expired or revoked access token (401), and a token for another agent (403);
- event reports with an unknown event type or a field the type does not have (422), or with more than 100 events;
- a manifest without an app name, with invalid or repeated tool names, or with an unknown tool class (400);
- a chat request without `model` or `messages` (400);
- a record request or placement report with a field the contract does not have, a content hash that is not a
  SHA-256, or an edit kind, layer or reason code the contract does not know (422).

Tools outside a non-empty contract are held back: the model is not offered them, and the request still succeeds. The
gateway lists them in `heldTools` and in the response header `x-faden-held-tools`.

## Inspect and control it

| Member | What it is |
|---|---|
| `requests` | Every request, in order: method, path, headers, body. |
| `modelCalls` | Every model call, as the model saw it. |
| `reported` | The events clients reported. |
| `manifests` | The manifests apps sent. |
| `languageOf(email)` | The language a user picked for all their clients, or `null`. |
| `heldTools` | Tools held back because the contract does not list them. |
| `approvals` | The answers to server tool approvals. |
| `createdAgents` | Agents created through the API. |
| `provenanceRecords` | The records it signed: the agent, the request and the signed record. |
| `placements` | The placement reports clients sent. |
| `receipts` | The receipts chat answers carried. |
| `signIns` | The devices signed in, and whether they were revoked. |
| `revoke(deviceId?)` | Ends every sign-in, or one device's. |
| `expireAccessTokens()` | Makes every access token expire, so the next request renews it. |
| `setProvenanceDown(down)` | Stops or starts the provenance module's service. |
| `handle(request)` | Answers one `Request`. `fetch` calls it. |

## Serve it over HTTP

`gateway.listen(port?, host?)` serves the fake over HTTP, for a browser or another process. It runs in Node, picks a
free port by default, and listens on `127.0.0.1`. It returns the address and a function to stop it:

```ts
import { FakeGateway } from "@fadenstack/testing";

const gateway = new FakeGateway({ agents: [{ slug: "my-assistant" }] });
const server = await gateway.listen();
console.log(`Fake server at ${server.url}`);
// ... run the client against server.url ...
await server.close();
```

The address is `http://`, so the client needs `allowInsecureHttp: true`:

```ts
const { client, tokens } = FadenstackClient.forAgent({
  serverUrl: server.url,
  agent: "my-assistant",
  allowInsecureHttp: true,
});
```

The fake sends no CORS headers. A browser extension with host permission for the address can call it; a web page
served from another origin cannot.

## Run a tool by hand

A tool's `invoke` (and a `defineTool` `run`) takes a `ToolCallContext`. `toolContext()` makes one for a test outside
an agent's session -- a signal that never aborts, call, session and turn ids, and no services unless you give them:

```ts
import { toolContext, toolServices } from "@fadenstack/testing";
import { PassThroughProvenance, provenanceServices } from "@fadenstack/testing/provenance";

const provenance = new PassThroughProvenance();
const result = await insertReply.invoke({ text: "<p>Hello</p>" }, toolContext({ services: provenanceServices(provenance) }));
expect(provenance.requests[0]!.content).toBe("<p>Hello</p>");
```

| Helper | What it is |
|---|---|
| `toolContext(options?)` | A `ToolCallContext`: `services`, `signal`, `callId`, `sessionId`, `turnId` as you give them. |
| `toolServices(...[key, service])` | The services of a hand-built call, by key (`toolServices([MyKey, myService])`). |
| `PassThroughProvenance` | From `@fadenstack/testing/provenance`: a `Provenance` whose `place()` keeps the request (`requests`), calls your insert with the content unchanged and returns an unmarked placement -- no record, no layers. `policy()` answers with the contract's default, or the `policy` you give. |
| `provenanceServices(provenance?)` | Services that give the call `provenance` (a new `PassThroughProvenance` by default), so `provenanceOf(context)` works. |

`@fadenstack/testing/provenance` needs `@fadenstack/provenance` installed (an optional peer dependency). To test the
marks themselves, run the tool in an agent with the provenance module against `FakeGateway`, or a marker with
`checkMarker` (see [Marking AI-generated content](provenance.md#testing-a-marker)).
