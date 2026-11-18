# Standalone mode

In standalone mode an agent has no Fadenstack server. It talks to the person's own AI server, any server that speaks the
OpenAI chat completions API (Ollama, LM Studio, vLLM, SGLang, llama.cpp, LiteLLM, OpenRouter, an OpenAI-compatible cloud).
The agent's definition, its tools, its approvals and its chats all stay on the device. The .NET SDK has the same mode
([Parity](parity.md#standalone-mode)).

```ts
import { EndpointDialect, StaticTokenProvider } from "@fadenstack/client";
import { AgentDefinition, FadenstackAgent } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder()
  .useEndpoint({
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:14b",
    dialect: EndpointDialect.ollama,
    // key: a TokenProvider over the app's own key store; leave it out for a server without a key
  })
  .useLocalProfile(AgentDefinition.fromJson(definitionJson))
  .build();
```

The person connects through the [connection wizard](connecting.md), which does the steps below and gives the app a
`ConnectionResult`. An app that does not use the wizard does them itself.

## The model

- `useEndpoint(endpoint, report?)` makes the person's endpoint the model. `report` is the endpoint check's result, if the
  app kept one: it says whether the model sees pictures.
- `useChatStreamer(streamer)` makes any `ChatStreamer` the model instead, for an app that has its own client. The agent
  never closes it. A machine policy that lists endpoints refuses it, because it names none.
- Both need `useLocalProfile`, and neither goes with `useServer` or `useClient`. `build()` throws if you mix them.
- The [machine policy](machine-policy.md) can forbid standalone (`standalone`), allow only listed endpoints
  (`endpoints`) and forbid plain http in the local network (`plainHttp`). `build()` throws `MachinePolicyError` for what it
  forbids.

## The agent's definition

`AgentDefinition.fromJson(json)` reads the app's own definition, in the shape of the server's agent body. It stands in
for the server's profile:

| Field | Meaning |
|---|---|
| `slug` | Required: lower-case letters, digits and inner hyphens, at most 64 characters. The agent's data is kept under it. |
| `name`, `description` | The agent's name (the slug when there is none) and a description. |
| `version.instructions` | The agent's own instructions. The person's own instructions, if any, come after them. |
| `version.host_tool_contract` | The host tools the agent may offer, each with its class (`risk`). A tool with no `risk`, or an unknown one, is unclassified and asks every time. |
| `version.local_mcp_mode`, `version.local_skills_mode` | `allow` or `disable`. Anything else is `disable`. |
| `version.ui` | The greeting, suggestions and the rest of the interface settings. |

`model_alias` is ignored. Every other field is kept, so a definition from a newer app reads and writes back whole.

`useLocalProfile(definition, ownInstructions?, options?)` takes the person's settings as `LocalProfileOptions`:
`localMcp` (off by default), `localSkills` (on by default), `vision` (the person's word on pictures) and `languageStore`.
The machine policy narrows them.

## The endpoint

A `ModelEndpoint` has:

| Field | Meaning |
|---|---|
| `baseUrl` | The base, with `/v1`: `http://localhost:11434/v1`. It has no query, fragment, user name or password. |
| `model` | The model's id on that server. `ChatOptions.model` overrides it per request. |
| `key` | A `TokenProvider` that gives the key when a request needs it. The SDK never stores a key. |
| `dialect` | What the server expects where servers differ. The default is `EndpointDialect.openAiCompatible`. |
| `allowPlainHttpInLan` | The person's opt-in for plain http to the local network (see below). |
| `timeoutMs`, `streamIdleTimeoutMs` | How long a request may take, and how long a stream may send nothing. Both default to 5 minutes. |
| `fetch`, `logger` | Your own `fetch` (tests, a proxy) and a logger. The logger sees the method, route, status and duration, never content or the key. |

**Dialects.** A `EndpointDialect` says how a request is written: the length field (`max_tokens` or
`max_completion_tokens`), the thinking switch, whether a stream asks for usage figures, the header for the key
(`Authorization: Bearer` or `api-key`), and how the server's text watermark is asked for or switched off. Built in:
`openAiCompatible`, `openAi`, `azureOpenAi`, `ollama`, `lmStudio`, `vllm`, `sglang`, `llamaCpp`, `liteLlm`, `openRouter`
and `mistral`. `EndpointDialect.named(name)` finds one; a dialect is a plain object, so `{ ...EndpointDialect.sglang,
requestWatermark: false }` makes a variant.

**Presets.** An `EndpointPreset` is a ready-made endpoint: an id, the usual base, the dialect, and whether it needs a key
(`EndpointPreset.all`, `EndpointPreset.named(id)`).

## The check

`new EndpointCheck(endpoint).run(options)` finds out what the endpoint can do and returns an `EndpointReport`. It asks the
endpoint's own origin and nowhere else:

1. `/models`: is it reachable, is the key accepted, which models are listed, and does the chosen one exist.
2. A one-token streamed chat: does it answer, and does the stream carry usage figures.
3. A tool probe: does the model call a tool. If not, `report.chatOnly` is true and the agent can only talk.
4. A picture probe, when `probeVision` is set: the model has to name the colour of a small green picture. A model that
   says what it takes in, through `/models`, is not asked.
5. The context length: the person's own (`contextLength`), else what the server says it runs with.
6. The text watermark status, from a table of what each kind of server is documented to do.

The report keeps what it found: `reachable`, `keyAccepted`, `models`, `chat`, `usage`, `toolCalls`, `vision`,
`contextLength`, `watermark` and a list of `problems` the app can say in plain words (`Unreachable`, `KeyRejected`,
`NotCompatible`, `ModelNotFound`, `NoToolCalls`, `ContextTooShort` and others). `report.usable` says that the agent can be
used. `toJson()` and `EndpointReport.fromJson(json)` keep it with the connection; the JSON is the .NET SDK's.

`EndpointCheck.placeOf(url)` says where an address points: `thisComputer`, `localNetwork` or `internet`. A browser cannot
resolve names, so only the spelling decides. There is no search for local servers: a page may not scan ports, so the check
covers the one address it is given.

## Text watermark status

`report.watermark` says whether text from this server carries the server's own mark: `Marks`, `IfAccountEnabled`,
`IfOperatorConfigured`, `Never` or `Unknown`, with the source the status rests on and the date it was read. Where a server
has a per-request switch, the dialect asks for the mark on text people read and switches it off only for calls no person
reads. `agent.endpointWatermark` gives the status for the agent in force, and `EndpointCheck.watermarkOf(endpoint)` gives
it with no request. The records the [provenance package](provenance.md) signs cite it.

## Keys

- The key goes into the app's own key store, never into settings, logs or the address. The wizard's `EndpointKeyStore`
  keeps it under a WebCrypto key and gives back a `TokenProvider`.
- The SDK asks the provider for the key at each request. A 401 is tried once more if the provider gives a different key.
- A key goes over plain http only to this computer (`localhost`, `127.0.0.1`, `[::1]`). The check reports it as
  `KeyUnencryptedOnThisComputer`. A machine policy with `plainHttp: forbidden` refuses even that.

## Transport rules

Every request follows these rules before anything is sent (OWASP ASVS 5.0 V12, V13):

- **https goes anywhere.** Plain http goes to this computer, and to the local network only after the person's opt-in for
  this endpoint (`allowPlainHttpInLan`) and never with a key.
- **A browser does not resolve names.** The host's spelling decides: a number in a private range (10/8, 172.16/12,
  192.168/16, link-local, fc00::/7), a single-label name, or a name ending in `.local`, `.lan`, `.home.arpa` or `.internal`
  counts as the local network. A name that only looks local can point anywhere, which is why https stays the way beyond
  this computer. The .NET SDK resolves the name instead.
- **A refusal is typed.** `EndpointPlainHttpRefusedError` has a `reason`: `notLocal`, `noOptIn`, `keyOverPlainHttp` or
  `forbiddenByPolicy`.
- **No redirect leaves the origin.** Requests are sent with `redirect: "manual"` and without cookies. Where the
  address is visible (Node), a redirect to the same origin is followed, at most three times; any other is refused. A
  browser hides where a redirect points, so none is followed and the error has the code `redirect`.
- **Errors are typed:** `EndpointKeyRejectedError`, `EndpointOriginRefusedError` (a local server that admits only some
  origins, as Ollama does with `OLLAMA_ORIGINS`), `EndpointModelNotFoundError`, `EndpointContextLengthError`,
  `EndpointNotCompatibleError` (usually a wrong base: it includes `/v1`), `EndpointUnreachableError`,
  `ServerCertificateError` (Node only: a browser cannot tell an untrusted certificate from an unreachable server) and
  `EndpointPlainHttpRefusedError`. A 429 is a `FadenstackRateLimitedError`.
- **Answers are capped.** A body read whole is at most 32 MiB of text.

## What is different from governed mode

- The agent reads its definition from the app, not its profile from a server. There is no server to report to, no grants
  and no organisation's tools or rules.
- The chats and the person's approvals are kept under the standalone principal, apart from any governed person's
  ([Data on the device](data-on-device.md#a-persons-databases)).
- In 0.3.0 the SDK offers no picture tools in standalone mode ([Pictures and web search](web-search.md)).
- Content marking uses the device's own signing, where the app adds `@fadenstack/provenance` ([Marking AI-generated
  content](provenance.md)).
