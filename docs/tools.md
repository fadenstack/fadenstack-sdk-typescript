# Tools and approvals

Give the agent tools from your application, and decide which of them run, which ask first, and which stay hidden.

Tools you define run on the device, in your application. The server also has tools of its own, which run on the
server. See [Tools](../../concepts/tools.md) for where tools run and how the server governs them.

## Define a tool

`defineTool` turns a function into a host tool:

```ts
import { defineTool } from "@fadenstack/agents";

const readPage = defineTool<{ page: number }>({
  name: "read_page",
  description: "Reads a page of the open schematic.",
  toolClass: "read",
  parameters: {
    type: "object",
    properties: { page: { type: "integer", description: "The page number." } },
    required: ["page"],
  },
  run: ({ page }) => schematic.page(page),
});
```

| Field | What it is |
|---|---|
| `name` | The name the model calls the tool by: letters, digits, `_` and `-`, up to 64 characters. Required. A name that breaks these rules throws a `TypeError`. |
| `description` | What the tool does. The model reads it to decide when to call the tool. |
| `parameters` | The arguments, as a JSON Schema object. Without it, the tool takes no arguments. |
| `toolClass` | `read`, `write`, `destructive` or `unknown`. Without it, the class is `unknown`, and the tool asks before it runs in every mode that offers it. |
| `openWorld` | The tool reaches outside the organisation. It is recorded and shown; no tool mode acts on it yet. |
| `run(args, context)` | The tool's body. Required. |

The type parameter (`{ page: number }` above) types the arguments `run` receives. It is not checked at run time
beyond the checks below, so keep it in line with `parameters`.

`run` may be synchronous or return a promise. What it returns goes to the model: a string as it is, anything else as
JSON, and nothing (`undefined` or `null`) as an empty string. If `run` throws, the turn goes on: the model gets
`Error:` and the error's message as the result, and the tool's outcome is `error`.

The second argument, `context`, describes the call:

| Field | What it is |
|---|---|
| `signal` | Aborted when the turn is stopped. Pass it on to `fetch` and other work you can cancel. |
| `callId` | The model's id for this call. |
| `sessionId` | The session's id. |
| `turnId` | The turn's id. |

## Arguments are checked first

Before a tool runs, and before anyone is asked to approve it, the SDK checks the arguments against `parameters`:

- every property in `required` is present and not `null`;
- each property given has the `type` its schema says: `string`, `integer`, `number`, `boolean`, `array`, `object` or
  `null`, or one of a list of types;
- a property with an `enum` has one of its values;
- with `additionalProperties: false`, no other properties are given.

Arguments that are not valid JSON fail as well. When the check fails, the tool does not run and nobody is asked. The
model gets `Error: Invalid arguments:` with what is wrong, so it can correct the call.

Only the top level is checked. Nested objects, the items of an array, and keywords such as `minimum` or `pattern` are
passed to the model as part of the schema but not checked by the SDK. Check in `run` what your tool relies on.

## Tool classes

Every tool has a class that says what it does:

| Class | Meaning |
|---|---|
| `read` | Only reads. Changes nothing. |
| `write` | Changes something that can be changed back. |
| `destructive` | May do something that cannot be undone. |
| `unknown` | Nobody said what it does. It is treated like `destructive`. |

The agent's host tool contract on the server can make a class stricter, never looser. When the agent starts, each of
your tools gets the stricter of your class and the contract's. If you gave no class, the contract's class is used.
Tools that a non-empty contract does not list are not offered to the model; an empty contract restricts nothing.
After `agent.start()`, `agent.tools` lists the tools with the classes they run under.

## The app manifest

When the agent starts, it tells the server what your application brings: every host tool with the class you gave it,
including tools the contract does not list yet. Administrators review new tools and take them into the agent's
contract. Until they do, the server holds back the tools that a non-empty contract does not list.

`describeApp` adds the application's name and version, the context it offers, and the greeting and suggestions it
would show:

```ts
import { FadenAgent } from "@fadenstack/agents";

const agent = FadenAgent.createBuilder()
  .useClient(client)
  .addTools(readPage)
  .describeApp({
    name: "Schematic viewer",
    version: "2.4.0",
    context: [{ id: "page:current", title: "The open page", kind: "page" }],
    ui: { greeting: "Ask me about the open schematic.", suggestions: ["What is on this page?"] },
  })
  .build();
```

The manifest only informs the server. Nothing in it changes what the agent may do. It is not sent when event
reporting is off, and a manifest the server cannot take never fails the start.

## Tool modes

The user picks a tool mode for each session. By each tool's class, the mode decides which tools run, which ask first,
and which are hidden. The modes are `off`, `read_only`, `ask` and `auto`, from narrowest to widest.
[Tools](../../concepts/tools.md) has the table of what each mode does with each class.

New sessions start in `ask`. `useDefaultToolMode` on the builder, and the agent's profile, can make that stricter,
never wider. To start a session in another mode, pass it to `startSession`. To change a session's mode, set
`session.toolMode`; the next turn runs in it:

```ts
const session = await agent.startSession("read_only");
session.toolMode = "auto"; // from the next turn on
```

A hidden tool is not offered to the model. If the model calls it anyway, the call is refused: the turn gets a
`tool_denied` notice with the category `mode`, and the model is told the tool is not allowed.

`session.effectiveToolMode` is the mode turns run in: `session.toolMode`, narrowed by any limit the agent's profile
sets. (planned) The Enterprise edition is planned; with it, an administrator may in future narrow the modes a user can
pick.

To show in your UI what a mode does with a tool, `@fadenstack/client` exports `decideTool(mode, toolClass)`, which
returns `run`, `ask` or `hidden`.

## Approvals

A tool call that asks goes to your approval handler. Pass it to the builder as a function, or as an object with a
`request` method:

```ts
import { ApprovalDecision, FadenAgent } from "@fadenstack/agents";

const agent = FadenAgent.createBuilder()
  .useClient(client)
  .addTools(readPage, deletePage)
  .useApprovals(async (request, signal) => {
    const answer = await showApprovalDialog(request, signal); // "allow", "always" or "deny"
    if (answer === "always") return ApprovalDecision.approveForSession();
    return answer === "allow" ? ApprovalDecision.approve() : ApprovalDecision.deny("Declined in the dialog.");
  })
  .build();
```

Without a handler, every call that asks is declined.

The handler gets an `ApprovalRequest`:

| Field | What it is |
|---|---|
| `callId` | The call's id. |
| `toolName` | The tool. |
| `toolClass` | The class it runs under. |
| `source` | `host`, `mcp`, or `gateway` for a tool the server runs. |
| `reason` | Why it asks: the tool's class and the mode, or the administrator's message for a server tool. |
| `arguments` | The call's arguments, already checked. Empty for a server tool. |

It returns an `ApprovalDecision`:

| Decision | Effect |
|---|---|
| `ApprovalDecision.approve()` | The tool runs. |
| `ApprovalDecision.approveForSession()` | The tool runs, and later calls of the same tool in this session run without asking. This holds when the session is opened again. |
| `ApprovalDecision.deny(reason?)` | The tool does not run. The model is told the user declined, with your reason, and the turn's outcome is `tool_denied`. |

A decision is a plain object, `{ approved, forSession?, reason? }`, so you can also return one directly.

The `signal` aborts when the turn is stopped. The SDK stops waiting for your handler then, so close your dialog when
it aborts. Approvals for your own tools have no time limit of their own.

### Server tools that ask

The server can hold one of its own tools for the user's approval. The same handler is asked, with `source` set to
`gateway`, and its answer goes back to the server. The server waits only for a limited time: when it runs out, the
`signal` aborts, the server does not run the call, and `approval_decided` reports that no answer came in time.

### Approvals in a chat UI

In a chat panel, approvals are cards in the conversation. `ApprovalBroker` from `@fadenstack/ui` is an approval
handler that turns each request into a card. See [The chat panel](chat-panel.md).

## Tools from other sources

A tool source adds tools once the agent's profile is known, for example the tools of plugins installed in your
application:

```ts
import { FadenAgent, type AgentContext, type AgentTool, type ToolSource } from "@fadenstack/agents";

const pluginTools: ToolSource = {
  async getTools(context: AgentContext): Promise<readonly AgentTool[]> {
    return loadPluginTools(context.profile.slug); // your application's own lookup
  },
};

const agent = FadenAgent.createBuilder().useClient(client).addToolSource(pluginTools).build();
```

`getTools(context, signal)` is called when the agent starts. `context` has the `client` and the agent's `profile`.
A host tool wins over a source's tool of the same name. If the source has a `dispose()` method, `agent.dispose()`
calls it.
