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
  description: "Reads a page of the open document.",
  toolClass: "read",
  parameters: {
    type: "object",
    properties: { page: { type: "integer", description: "The page number." } },
    required: ["page"],
  },
  run: ({ page }) => document.page(page),
});
```

| Field | What it is |
|---|---|
| `name` | The name the model calls the tool by: letters, digits, `_` and `-`, up to 64 characters. Required. A name that breaks these rules throws a `TypeError`. |
| `description` | What the tool does. The model reads it to decide when to call the tool. |
| `parameters` | The arguments, as a JSON Schema object. Without it, the tool takes no arguments. |
| `toolClass` | `read`, `write`, `destructive` or `unknown`. Without it, the class is `unknown`, and the tool asks before it runs in every mode that offers it. |
| `openWorld` | The tool reaches outside the organisation. Below `auto`, a call to it asks ([Open-world tools](#open-world-tools)). |
| `output` | What the tool writes for people to read: `{ argument, mediaType, edit }`. See [Content people read](#content-people-read). |
| `describe(args, signal)` | What a call acts on, in the user's words (`button "Send" on mail.example.com`), for the approval card. Called only when the user is asked; may return a promise. A failure, nothing, or no answer within 3 seconds leaves the card with the arguments. |
| `run(args, context)` | The tool's body. Required. |

The type parameter (`{ page: number }` above) types the arguments `run` receives. It is not checked at run time
beyond the checks below, so keep it in line with `parameters`.

`run` may be synchronous or return a promise. What it returns goes to the model: a string as it is, anything else as
JSON (`[]` and `{}` too). For nothing (`undefined`, `null`, an empty or a blank string) the model gets
`NO_TOOL_RESULT`, "The tool returned no result.": an empty tool message makes some models stop or guess. The
transcript and the tool's card keep what `run` returned. If `run` throws, the turn goes on: the model gets `Error:`
and the error's message as the result, and the tool's outcome is `error`.

The second argument, `context`, describes the call:

| Field | What it is |
|---|---|
| `signal` | Aborted when the turn is stopped. Pass it on to `fetch` and other work you can cancel. |
| `callId` | The model's id for this call. |
| `sessionId` | The session's id. |
| `turnId` | The turn's id. |
| `services` | What modules give tools for this call, by key: `context.services.get(Provenance)`. Undefined for a key no module gives. |

### Names the SDK keeps

Five names are the SDK's own (`RESERVED_TOOL_NAMES`). A Fadenstack gateway gives each the class of the SDK's tool, so an
app's tool cannot take one:

| Name | The SDK's tool |
|---|---|
| `find_tool` | The tool search of `OnRequestTools` (`FIND_TOOL_NAME`): read |
| `load_skill`, `read_skill_resource` | Skills on the device (coming): read |
| `run_skill_script` | Kept, and never offered: skill scripts stay off |
| `web_search` | Web search (coming): read, open-world |

- `addTools`, a module's `configure`, and `OnRequestTools` (its constructor and `set`) refuse a tool of one of these
  names with a `TypeError`.
- A tool source of the app's that brings one has it left out, and it is logged (event 2016). Only the SDK's own sources
  bring them.

## Content people read

A tool that writes content people read -- a reply into a mail, a paragraph into a document, a picture into a slide --
declares it with `output`: the argument that carries the content, its media type, and what kind of edit it is.

```ts
const insertReply = defineTool<{ text: string }>({
  name: "insert_reply",
  toolClass: "write",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: { argument: "text", mediaType: "text/html", edit: "generated" },
  run: ({ text }, context) => editor.insert(text),
});
```

| Edit kind | Meaning | Marked as made with AI |
|---|---|---|
| `generated` | New content | Yes |
| `rewritten` | Changes style, structure or meaning | Yes |
| `summarised` | A summary of existing content | Yes |
| `translated` | A translation | No |
| `corrected` | Spelling, grammar, minor stylistic polish | No |
| `formatted` | Layout, styles, format conversion | No |
| `extracted` | Selected or structured existing content, unsummarised | No |

`edit` may also be a function of the call's arguments, for a tool that decides per call:
`edit: (args) => (args.mode === "polish" ? "corrected" : "rewritten")`. It returns `null` for a call whose argument
is not content for people to read -- a form tool that picks an option in a drop-down or ticks a check box:
`edit: ({ kind }) => (kind === "text" ? "generated" : null)`. Such a call is not marked and not reported. The
declaration is metadata: it goes in the [app manifest](#the-app-manifest), and the provenance module
(`@fadenstack/provenance`) checks that the content went through its `place()`, which marks it where it lands. See
[Marking AI-generated content](provenance.md).

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
Tools that a non-empty contract does not list are not offered to the model. An agent without a contract, or a
contract entry without a `risk`, vouches for nothing: those tools are `unknown`, whatever class you gave them, and
ask every time. After `agent.start()`, `agent.tools` lists the tools with the classes they run under.

The server may also hold a stricter class for a tool than the contract says (an administrator's classification). It
tells the session when the model calls the tool, and the call runs under the stricter of the two.

## The app manifest

When the agent starts, it tells the server what your application brings: every host tool with the class you gave it
and the content it declares it writes (`output`, with its edit kind when the kind is fixed), including tools the
contract does not list yet. Administrators review new tools and take them into the agent's
contract. Until they do, the server holds back the tools that a non-empty contract does not list.

`describeApp` adds the application's name and version, the context it offers, and the greeting and suggestions it
would show:

```ts
import { FadenstackAgent } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(readPage)
  .describeApp({
    name: "Document viewer",
    version: "2.4.0",
    context: [{ id: "page:current", title: "The open page", kind: "page" }],
    ui: { greeting: "Ask me about the open document.", suggestions: ["What is on this page?"] },
  })
  .build();
```

The manifest only informs the server. Nothing in it changes what the agent may do. It is not sent when event
reporting is off, and a manifest the server cannot take never fails the start.

`agent.app` returns what you described (undefined without `describeApp`). The chat panel's About shows the name and
version.

## Tool modes

The user picks a tool mode for each session. By each tool's class, the mode decides which tools run, which ask first,
and which are hidden. The modes are `off`, `read_only`, `ask` and `auto`, from narrowest to widest.
[Tools](../../concepts/tools.md) has the table of what each mode does with each class.

New sessions start in the agent's default level from the server: `ask` unless the agent's author set another, and
`ask` from an older server or for a level this SDK does not know. `useDefaultToolMode` on the builder caps it, never
widens it (for an app that never starts in `auto`, say). To start a session in another mode, pass it to `startSession`.
To change a session's mode, set `session.toolMode`; the next turn runs in it:

```ts
const session = await agent.startSession("read_only");
session.toolMode = "auto"; // from the next turn on
```

A hidden tool is not offered to the model. If the model calls it anyway, the call is refused, by the server as it
hands the call over or else by the session: the turn gets a `tool_denied` notice, and the model is told the tool is not
allowed.

`session.effectiveToolMode` is the mode turns run in: `session.toolMode`, narrowed by `agent.ceiling`, the limit the
agent's profile sets: the narrowest of an administrator's ceiling and the agent's highest level. A level this SDK does
not know counts as `read_only`, never as no limit.

To show in your UI what a mode does with a tool, `@fadenstack/client` exports `decideTool(mode, toolClass)`, which
returns `run`, `ask` or `hidden`.

## Approvals

A tool call that asks goes to your approval handler. Pass it to the builder as a function, or as an object with a
`request` method:

```ts
import { ApprovalDecision, FadenstackAgent } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(readPage, deletePage)
  .useApprovals(async (request, signal) => {
    // Offer only what the request allows: request.canAllowForSession, request.canAllowAlways.
    const answer = await showApprovalDialog(request, signal); // "allow", "chat", "always" or "deny"
    if (answer === "chat") return ApprovalDecision.approveForSession();
    if (answer === "always") return ApprovalDecision.approveAlways();
    return answer === "allow" ? ApprovalDecision.approve() : ApprovalDecision.deny("Declined in the dialog.");
  })
  .build();
```

Without a handler, every call that asks is declined.

The handler gets an `ApprovalRequest`:

| Field | What it is |
|---|---|
| `sessionId`, `turnId` | The session and the turn the call belongs to. The SDK always sets them. See [Several chats, one handler](#several-chats-one-handler). |
| `callId` | The call's id. |
| `toolName` | The tool. |
| `toolClass` | The class it runs under. |
| `source` | `host`, `mcp`, or `gateway` for a tool the server runs. |
| `reason` | Why it asks: the tool's class and the mode, or the administrator's message for a rule or a server tool. |
| `arguments` | The call's arguments, already checked. Empty for a server tool. |
| `canAllowForSession` | Whether to offer "Allow for this chat". |
| `canAllowAlways` | Whether to offer "Allow always". |
| `requiredByRule` | An administrator's "Ask first" rule covers the call. |
| `openWorld` | The tool reaches outside the organisation: what it is given goes to another site. |
| `target` | What the call acts on, as the tool's `describe` says it, one line of at most 300 characters. Show it: the arguments alone (`ref: e12`) seldom tell the user what they allow. |
| `server` | For a tool from a local MCP server (`source` is `mcp`), the server's label. Name it on the card: "From Files, an MCP server on this computer". |
| `readOnlyHint`, `destructiveHint` | What the MCP server's own annotations say: the tool only reads, or may delete or overwrite. Absent when the server said nothing. The card shows them; no mode acts on them. A tool source sets them on its `AgentTool`. |

It returns an `ApprovalDecision`:

| Decision | Effect |
|---|---|
| `ApprovalDecision.approve()` | The tool runs, this once. |
| `ApprovalDecision.approveForSession()` | The tool runs, and later calls of the same tool run without asking while this session object lives. A session opened again asks again. |
| `ApprovalDecision.approveAlways()` | The tool runs, and later calls of it run without asking in every session on this device, until the approvals are reset. |
| `ApprovalDecision.deny(reason?)` | The tool does not run. The model is told the user declined, with your reason, and the turn's outcome is `tool_denied`. |

A decision is a plain object, `{ approved, forSession?, always?, reason? }`, so you can also return one directly.
`forSession` and `always` count only where the request offers them; elsewhere they approve the one call.

The `signal` aborts when the turn is stopped. The SDK stops waiting for your handler then, so close your dialog when
it aborts. Approvals for your own tools have no time limit of their own.

### What asks, in order

A call the tool mode or an administrator's rule asks about is settled by the first of these that applies:

1. An administrator's "Ask first" rule covers it: it asks, with Allow and Deny only, every time. Nothing below
   changes that.
2. The tool is `destructive` or `unknown`: it asks, with Allow and Deny only, every time.
3. The user allowed the tool always, under the class it has now: it runs without asking. Not for an open-world call
   below `auto`.
4. The user allowed the tool for this chat: it runs without asking.
5. It asks, with Allow, Allow for this chat, Allow always and Deny; an open-world call below `auto` with Allow, Allow
   for this chat and Deny.

The chat panel's card for such a tool says where it comes from and, when nobody classified the tool, "Your organisation
has not checked this tool." followed by the server's own hint (the warning wins when it gave both). The entry also keeps
the tool's class (`tool_class`) and the server (`server`), so a chat opened again draws the same card; an entry written
by an earlier version takes the class from the call's start.

Every outcome goes in the session's transcript as an `approval.decision` entry, with what let the call through
(`scope`: `once`, `chat`, `always` or `grant`; a grant for a time, a stretch of work and Bypass are all `grant`), and is
reported to the server the same way. A call a grant let through also records `grant_id`, and, where the person picked a
time, `grant_minutes` (what they picked) and `grant_confirmed_minutes` (what the server confirmed); `outside_grant` says
a link led the call's place out of a work grant's places and the person was asked: the same keys as the .NET SDK's.

### Open-world tools

A tool that reaches outside the organisation (`openWorld`, such as a web search) is open-world. What it is given leaves
the organisation, and text the model read (a page, a mail, a file) can try to put private data into it (OWASP Top 10
for LLM Applications 2025, LLM02 and LLM06). So:

- In `read_only` and `ask`, a call to an open-world tool asks, a read one too. `auto` and `bypass` run it as its class
  says.
- The person may allow it for the rest of the conversation (Allow for this chat). Below `auto`, Allow always and a time
  grant are not offered for it, and an "always" saved before does not answer it: the next conversation asks again. A
  server grant that covers the call still covers it.
- The mark is the stricter of the tool's own (`openWorld`) and the gateway's: a Fadenstack gateway from 0.7.1 says
  `openWorld` when an administrator's class rule marks a tool, and for the SDK's `web_search`.
- An agent's contract that sets `approval: "never"` for a read or write tool still runs it unasked, as for any tool the
  mode would ask about.
- `decideTool(mode, toolClass, approval, openWorld)` and `conversationOnly(mode, openWorld)` (`@fadenstack/client`)
  say what applies.

### Allow always

What the user allows always is kept per signed-in user and agent on this device, by tool name and class, in an
`ApprovalStore`: the user's own IndexedDB database in a browser and memory elsewhere unless you pass your own to
`useApprovalStore`, so two people in one browser profile never see each other's. It is checked at every call: a tool
that became `destructive` or `unknown`, or that an administrator's rule now covers, asks again.

`agent.listApprovals()` lists them, for a settings page. `agent.resetApprovals()` forgets every tool's,
`agent.resetApprovals("write_page")` one tool's.
`session.resetApprovals()` forgets what was allowed for that chat.

### Bypass mode

Bypass is the server's: a person switches approvals off for one conversation after signing in again in the browser,
where the organisation allows it, and the server records every call under it. The SDK offers it when the app can open
that second sign-in (`useStepUpHandler`) and announces it to the server only then: `session.startBypass()` draws the
confirmation, runs the sign-in and asks the server for the grant; `session.stopBypass()` ends it. Under it, `destructive`
and `unknown` calls the gateway says the grant covers run without asking; an administrator's "Ask first" rule, a tool
that asks every time and the server's own questions still ask, and a tool the mode hides stays hidden. The whole flow
is in [Server-held grants and Bypass](server-grants.md#bypass).

`usePermissionMode("bypass")` asks for it in your code, with no card but the same sign-in and grant. Where Bypass cannot
be had -- the server does not offer it, or the app opens no second sign-in -- a session that would run in `ask` runs in
`auto` instead, never above `useDefaultToolMode` or the agent's ceiling. Nothing is approved without the person: the
agent warns once on the console when it starts.

### Rules from the administrator

An administrator can say a tool needs the user's approval ("Ask first"). When the model calls one of your tools such a
rule covers, the server marks the call before the session runs it, and the session asks with the administrator's
message as the `reason`, whatever the tool's class, every time. A tool a rule denies is not offered, and a call of it
is refused. (An older version of this SDK does not read the mark.)

### Server tools that ask

The server can hold one of its own tools for the user's approval. The same handler is asked, with `source` set to
`gateway`, and its answer goes back to the server. The server says the tool's class and whether a rule asks; one that
says neither asks every time. The server waits only for a limited time: when it runs out, the `signal` aborts, the
server does not run the call, and `approval_decided` reports that no answer came in time.

### Several chats, one handler

Every approval request names the session (`ApprovalRequest.sessionId`) and the turn (`turnId`) it belongs to. A screen
that shows several chats at once can therefore use one approval handler and still put each card in the chat that owns
it. `ApprovalBroker` does this: a chat view model asks it for the requests of the session it shows, and gets those and
the requests that name no session. A listener that gives no session gets every request. The field is absent only on a
request you built by hand. When no chat is listening, the broker declines the request.

### Approvals in a chat UI

In a chat panel, approvals are cards in the conversation. `ApprovalBroker` from `@fadenstack/ui` is an approval
handler that turns each request into a card. See [The chat panel](chat-panel.md).

## Tools from other sources

A tool source adds tools once the agent's profile is known, for example the tools of plugins installed in your
application:

```ts
import { FadenstackAgent, type AgentContext, type AgentTool, type ToolSource } from "@fadenstack/agents";

const pluginTools: ToolSource = {
  async getTools(context: AgentContext): Promise<readonly AgentTool[]> {
    return loadPluginTools(context.profile.slug); // your application's own lookup
  },
};

const agent = FadenstackAgent.createBuilder().useClient(client).addToolSource(pluginTools).build();
```

`getTools(context, signal)` is called when the agent starts. `context` has the `client` and the agent's `profile`, and
`report(event)`, which reports an event to the server (names and counts, never content). A host tool wins over a
source's tool of the same name, and the first source over a later one; the tool left out is logged with what won
(event 2017). A source never brings a [name the SDK keeps](#names-the-sdk-keeps). If the source has a `dispose()`
method, `agent.dispose()` calls it.

A source can also have a `declared()` method that returns the host tools it brings before the agent's contract settles
them. The app manifest reports these, which is how the server learns of tools its contract does not list yet.

### A source whose tools change

A `ChangingToolSource` is a tool source that also has `onChanged(listener)`: it calls the listener, from anywhere, when
`getTools` would now answer differently, and returns the function that unsubscribes. Use it for a setting that switches
a group of tools on or off, or a list your application edits.

```ts
import type { AgentContext, AgentTool, ChangingToolSource } from "@fadenstack/agents";

class PluginTools implements ChangingToolSource {
  readonly #listeners = new Set<() => void>();
  #tools: readonly AgentTool[] = [];

  set(tools: readonly AgentTool[]): void {
    this.#tools = tools;
    for (const listener of [...this.#listeners]) listener();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getTools(context: AgentContext): Promise<readonly AgentTool[]> {
    return this.#tools;
  }
}
```

The agent notes that the source changed and asks it again at the start of the next turn, never inside a turn, so the
tools of a turn do not change under it. The tools are settled by the same rules as at start: the contract drops what it
does not list and sets the class. A tool that went away is refused by name with "(name) is no longer available." If the
source throws, the agent keeps the tools it had. `isChangingToolSource(source)` tells the two kinds apart.

### Tools that are offered per conversation

An `AgentTool` can have a `scope`, a `ToolScope`. `offers(tool, session)` says whether the model is offered the tool in
that conversation now, and `beforeCall(tool, session)` runs before a call is approved or run: it returns the text that
answers the call instead of running it (the tool was not in scope and is now), or `undefined` to run it. A tool that
is not offered can still be called by name. `OnRequestTools` is a tool source built on this: see
[Local tools](local-tools.md).

## The server's tools

The organisation's MCP servers run on the server. `client.agent.listTools()` lists the tools they bring for the signed-in
user and this agent (`GET /v1/agents/{agent}/tools`), for a screen that shows them:

```ts
const tools = await client.agent!.listTools();
if (tools === null) {
  // the server is older and does not list them
} else {
  for (const t of tools) console.log(t.name, t.server, t.allowed, t.enabled);
}
```

Each `AgentToolInfo` has the `name` the model calls it by (`mcp.github.search`), the `server` that brings it, a
`description`, `allowed` (this agent's tool rules let its requests be offered the tool and run it) and `enabled` (an
administrator has not switched it off). It holds names and descriptions only, never how the server is reached. A field
that is not a boolean `true` reads as `false`, and an entry without a name is left out. The call answers `null` when the
server has no such route (a 404 whose code is not `agent_not_found`); an unknown agent is an error. The .NET SDK has
`ListToolsAsync`.

## Call ids

A model names each tool call with an id. When a call has no id, or the same id as another call in the same round, the
SDK gives it one of its own, `fs-{turn}-{round}-{index}`, so every call in the transcript, in events and in approval
requests is told apart. The id it gets is the one in `tool_started`, `tool_completed` and `ApprovalRequest.callId`.

A word from the server about a call (a refusal, or a mark that it asks) aims at a call by its position in the round or
by its id. A word that cannot single out one call (it names no id, or one id that several calls have) covers every call
of that tool in the round: a refusal is never lost, and a mark asks.

## Host commands

`session.invokeTool(name, args, options)` runs one host tool without a model request, for a button or a view of your
application. It goes through the same policy, approval cards and transcript as a call the model asks for. See
[Host commands and central policy](host-commands.md).
