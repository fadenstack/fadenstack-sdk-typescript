# Extending

This page covers the SDK's extension points: modules, stages and their fixed order, tool services, tool sources, the client's transport, and renderers for the chat panel.

## Modules

A module is a package that plugs into the builder. It is a `FadenstackModule`:

```ts
interface FadenstackModule {
  readonly name?: string;
  configure(builder: AgentBuilder): void;
}
```

`builder.use(module)` calls `configure`, where the module adds its stages, tool sources, tool services or tools. `@fadenstack/provenance` is such a module: `provenanceModule()` is named `provenance`. A module is active only when it is added to the builder, never just by being installed.

### Required client modules

An agent's profile on the server can list client modules the agent needs (`required_client_modules`). When the agent starts, every listed name must be the `name` of a module added with `use`. Otherwise `start()` throws a `FadenstackError` that names the missing modules ("needs the module(s) ... add them to the builder"), and no session starts. The profile is checked again when it is read again.

A module without a `name` can be added, but it cannot satisfy a requirement.

```ts
import { StageOrder, type FadenstackModule } from "@fadenstack/agents";

export const auditModule: FadenstackModule = {
  name: "example.audit",
  configure: (builder) => builder.addToolStage(StageOrder.custom, toolLogStage),
};
```

```ts
builder.use(auditModule);
```

## Stages

Stages wrap the agent's work. There are two kinds:

- `addChatStage(order, wrap)` wraps the `ChatStreamer` that carries the agent's requests to the gateway. `wrap` gets the inner streamer and returns the one that wraps it.
- `addToolStage(order, stage)` wraps each tool call. A `ToolStage` has an `invoke(invocation, next)` method that sees the call before the tool runs and the result after.

### The order is fixed

Stages run in the order of their `order` value, whatever order they are added in. A module picks its slot, not its position in the builder chain. `StageOrder` names the slots:

| Constant | Value | Slot |
|---|---|---|
| `StageOrder.context` | 100 | Context added to a request. |
| `StageOrder.pii` | 200 | Personal data masked on the device. |
| `StageOrder.provenance` | 300 | Content marking: the turn's receipts, and the check that tools mark what they place. |
| `StageOrder.custom` | 500 | Your own stages. |

A lower value sits further from the transport. A request passes the stages from the lowest value to the highest and then goes to the gateway: context first, then masking, then custom stages. A tool call passes them in the same order on the way to the tool, and the result comes back through them in reverse. Give each of your stages its own value when their order matters.

Tool stages run after the approval: the agent decides first whether a call may run, and only calls that run reach the stages.

### A tool stage

```ts
import type { ToolInvocation, ToolInvoker, ToolStage } from "@fadenstack/agents";

const toolLogStage: ToolStage = {
  async invoke(invocation: ToolInvocation, next: ToolInvoker): Promise<unknown> {
    console.debug(`${invocation.tool.name} (${invocation.toolClass}) starts.`);
    try {
      return await next(invocation);
    } finally {
      console.debug(`${invocation.tool.name} ended.`);
    }
  },
};
```

A `ToolInvocation` carries the `tool`, the `arguments` the tool gets (a stage may replace them, for example to put masked values back), the tool's `toolClass`, and the `context` (`signal`, `callId`, `sessionId`, `turnId` and `services`). Call `next` to go on to the next stage and finally the tool; what you return is the tool's result.

### A chat stage

```ts
import type { ChatStreamer } from "@fadenstack/client";

const timing = (inner: ChatStreamer): ChatStreamer => ({
  async *stream(messages, options) {
    const started = performance.now();
    yield* inner.stream(messages, options);
    console.debug(`Model call took ${Math.round(performance.now() - started)} ms.`);
  },
});

builder.addChatStage(StageOrder.custom, timing);
```

A `ChatStreamer` has one method, `stream(messages, options?)`, that returns the updates as an async iterable. It is what the client's `chat` is, and what a stage returns.

## Tool services

A module can give tools a service for each call. A key identifies the service, and the module adds a factory for it:

```ts
import { toolServiceKey } from "@fadenstack/agents";

export const Audit = toolServiceKey<AuditLog>("audit");

builder.addToolService(Audit, (call) => new AuditLog(call.sessionId, call.callId));
```

A tool reads it with `context.services.get(Audit)`; the factory runs on the first `get` in a call, and it runs once per call. It returns `undefined` when no module gives that service. Keys are compared by identity, so two modules cannot take each other's service by its name. A second factory for the same key throws.

The factory gets the call (`ToolServiceCall`): the tool, its class, its arguments, the ids of the call, session and turn, the call's `signal`, and the running agent's `client` and `profile`. It also has two methods for the module's work on the call:

- `record(type, data)` adds an entry of the module's own type, such as `provenance.placed`, to the session's transcript. The SDK's own entry types are refused, since they make the history the model gets; keep content out of the data. A module's entries are not sent to the model.
- `notice(notice)` raises a notice on the turn for the user: it goes into the turn's notices and the transcript.

A stage reaches the same service through `invocation.context.services`.

## Tool sources

A `ToolSource` adds tools once the agent's profile is known, for example tools that depend on the agent's policy:

```ts
interface ToolSource {
  getTools(context: AgentContext, signal?: AbortSignal): Promise<readonly AgentTool[]>;
  declared?(): readonly AgentTool[];
  dispose?(): void | Promise<void>;
}
```

Add one with `builder.addToolSource(source)`. The `AgentContext` gives the source the `client`, the agent's `profile` and `report(event)`, which reports an event to the server (names and counts, never content). A host tool wins over a source's tool of the same name. A source with `dispose()` is disposed with the agent.

A source whose tools change while the agent runs is a `ChangingToolSource`; one that offers its tools per conversation sets a `scope` on them. `OnRequestTools` is both. See [Tools from other sources](tools.md#tools-from-other-sources) and [Local tools](local-tools.md).

An `AgentTool` has a `source`, `host` for tools your application defines and `mcp` for tools a source brings from an MCP server, and a `server` label for an MCP tool. A browser has no local MCP process, so the SDK itself brings no `mcp` tools.

## The client's transport

`client.transport` makes authenticated requests to the server with the client's tokens and typed errors. Use it to add requests the SDK does not cover yet, without copying the plumbing. (`client.getFeatures()` already makes this one; it shows the pattern.)

```ts
const transport = client.transport;
const features = await transport.get<{ edition: string }>(transport.gateway("v1/features"));
```

| Member | Meaning |
|---|---|
| `gateway(relative)`, `api(relative)` | The URL of a gateway route (`/v1`) or a backend route (`/api`). |
| `get<T>`, `post<T>`, `patch<T>`, `delete`, `json<T>(method, url, body)` | JSON in, JSON out, errors as typed exceptions. |
| `request(build, signal)`, `open(build, signal)` | Any request. `build` returns the request; it is called again for the one retry after a 401. |
| `serverUrl`, `apiUrl`, `timeoutMs`, `fetch` | The client's settings. |
| `logger`, `useLogger(logger)` | Where the client logs. See [Logging](agent.md#logging). |

Requests carry the bearer token. When the server answers 401, the transport gets a fresh token and retries once.

## Renderers

The chat panel turns what the agent does into parts of the conversation. You can add to that in two places:

- `renderers` in the view model's options are `AgentEventRenderer`s: `render(event, turn, context)` turns a gateway event (`faden.citations` and others) into parts of the turn and returns `true` when it handled the event. They are tried before the built-in ones, and the first that handles an event wins. Core renders citations, PII notices and the notice for an unmarked answer, and shows a generic notice for an event it does not know.
- `partRenderers` on the panel (React) or `part-renderers` (Vue) are views for parts a module adds: a function from a `ResponsePart` and the `strings` to an element, or `null` to pass.

The texts are a third place: `languages` and `strings` change the words or add a language. See [The chat panel](chat-panel.md#views-for-parts).
