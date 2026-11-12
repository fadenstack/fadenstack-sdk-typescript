# Build an agent

Connect to the server, sign in to an agent, build it with your tools, and run turns in a session.

## The client

A `FadenstackClient` is the connection to a Fadenstack server. For an agent, create it with `FadenstackClient.forAgent`, which
returns the client and the sign-in that goes with it:

```ts
import { FadenstackClient } from "@fadenstack/client";

const { client, tokens } = FadenstackClient.forAgent({
  serverUrl: "https://ai.example.internal",
  agent: "docs-assistant",
});
```

One client works for one agent. Its chat goes to that agent's endpoint, `/v1/agents/{agent}/chat/completions`. To
work with two agents, create two clients.

| Option | What it does |
|---|---|
| `serverUrl` | The Fadenstack server. Required. |
| `agent` | The agent's slug or id. Required. |
| `store` | Where the sign-in is kept between runs (a `TokenStore`). In memory by default. |
| `apiUrl` | The server's backend for sign-in, when it is not at `serverUrl`. |
| `fetch` | The `fetch` to use. The global one by default. |
| `timeoutMs` | How long one request may take, in milliseconds. The default is five minutes. A streamed answer that has started is not cut off by it. |
| `allowInsecureHttp` | Allows an `http://` address. Only for a development server on your own machine. |

The client also takes the options described in [Plain chat completions](plain-api.md#the-client-without-an-agent).

The client never sends the browser's cookies. If the user is also signed in to the Fadenstack console in the same
browser, that session never acts in place of your application's sign-in.

## Sign in to the agent

An agent sign-in belongs to one user on one device. You get it in two steps:

1. Get the user's login token: from `loginWithPassword`, or from your organisation's single sign-on.
2. Exchange it for the agent sign-in with `tokens.signIn(loginToken, deviceLabel)`.

```ts
import { loginWithPassword } from "@fadenstack/client";

if (!(await tokens.isSignedIn())) {
  const login = await loginWithPassword({ apiUrl: "https://ai.example.internal", email, password });
  await tokens.signIn(login, "Viewer on PC-7"); // the login token is not kept
}
```

`loginWithPassword({ apiUrl, email, password, fetch?, signal? })` returns the user's login token. Wrong credentials
throw a `FadenstackApiError` with the code `LOGIN_BAD_CREDENTIALS`.

`signIn(loginToken, deviceLabel?, signal?)` creates the sign-in for this device and keeps it in the token store. The
login token itself is not kept: hold it only as long as the sign-in takes. The server refuses the sign-in with a
`FadenstackPermissionError` (403) when the user has no grant for the agent.

The device label is what administrators see in the agent's list of sign-ins, for example the application and the
computer. It is cut to 200 characters. After signing in, `tokens.deviceId` is the id the server lists and revokes the
sign-in by.

The sign-in is a short-lived access token and a refresh token. The SDK renews the access token before it expires, and
the server replaces the refresh token on every renewal. Requests that need a token at the same time share one renewal.
When the server refuses the renewal (the sign-in was revoked, its refresh token was used twice, or the user lost access
to the agent), the SDK forgets the sign-in and throws a `FadenstackSignInRequiredError`. Sign in again.

| Method | What it does |
|---|---|
| `isSignedIn()` | Whether a sign-in is kept that can still be renewed. |
| `signIn(loginToken, deviceLabel?, signal?)` | Signs in this device and keeps the sign-in. Returns the `TokenSet`. |
| `signOut()` | Forgets the sign-in on this device. It does not end the sign-in on the server: an administrator does that among the agent's sign-ins in the console. |
| `getAccessToken(signal?)` | A valid access token, renewed if needed. The client calls this for you. |

See [Your first agent](../../get-started/first-agent.md) for registering the agent and granting it to users.

## Sign in by pairing

An app that cannot ask for a password (single sign-on, a browser extension, an add-in) signs in by pairing. It shows a
short code, the person approves it in the web console, and the app receives the same tokens a sign-in issues.

```ts
import { AgentPairing } from "@fadenstack/client";

const pairing = new AgentPairing({ apiUrl: "https://ai.example.internal", store });
const app = { name: "Viewer", version: "1.0", os: "Windows 11" }; // what the approval page shows as the app's own word
const start = await pairing.start("docs", "Viewer on PC-7", app);
show(start.userCode, start.verificationUriComplete);
await pairing.wait(start, { onProgress, signal }); // saved in the store for "docs"
```

`wait` polls until the person approves, and returns a `PairingResult` (`agentSlug`, `deviceId`, `signedInUser`, and
`ignoredAgents` when there are any). It throws a `FadenstackPairingDeniedError` when the person denies the pairing and
a `FadenstackPairingExpiredError` when the code expires; `start` throws a `FadenstackRateLimitedError` when too many
pairings were started from one address. Open `verificationUriComplete` in the person's browser, for example with
`openInBrowser` from `@fadenstack/agents`: opening it approves nothing.

### The page is on the server's own address

The page the person opens (`verificationUri` and `verificationUriComplete`) must be on the origin of `apiUrl`. The
server may name it with a relative address, which is resolved against `apiUrl`. A page on another origin, or with a
user name or password in its address, is refused with a `FadenstackError` before anything is shown or opened. The
pairing code the SDK polls with stays inside the `PairingStart`: it is not a property, and `toString()` and
`toJSON()` leave it out.

### A server that is too old

A server without the pairing routes answers 404, or 405 from core 0.7.0. `start`, `wait` and `redeem` then throw a
`FadenstackPairingUnsupportedError`. Fall back to the password for that server:

```ts
import { FadenstackPairingUnsupportedError, loginWithPassword } from "@fadenstack/client";

try {
  const start = await pairing.start("docs", "Viewer on PC-7", app);
  show(start.userCode, start.verificationUriComplete);
  await pairing.wait(start);
} catch (error) {
  if (!(error instanceof FadenstackPairingUnsupportedError)) throw error;
  const login = await loginWithPassword({ apiUrl: "https://ai.example.internal", email, password });
  await tokens.signIn(login, "Viewer on PC-7");
}
```

### One approval for several agents

An app suite with several agents pairs once. `start` takes the further agents after the first (at most 8 agents in all,
no repeats; more is refused before any request). The person sees every agent in the console and approves them together.
`wait` returns the tokens of the first agent, or of `agent`; `redeem` collects each other agent's tokens after the
approval, without waiting. Each agent can be collected once, and each is a sign-in of its own, saved in the store under
that agent.

```ts
const start = await pairing.start("word", "Office on PC-7", app, { agents: ["excel", "outlook"] });
show(start.userCode, start.verificationUriComplete);
await pairing.wait(start);                 // the approval; tokens for "word"
await pairing.redeem(start, "excel");      // one request each, no waiting
await pairing.redeem(start, "outlook");
```

- `start.agents` lists the agents as the server stored them. A server that ignores `agents` (older than this) stores only
  the first: `start.agents` is empty, `start.ignoredAgents` names the others, and `redeem` or `wait` for them throw a
  `FadenstackPairingAgentError` with `reason: "not_offered"` before sending anything. Pair for those agents separately.
- A person may lack the right to use some of the agents. The approval skips those; collecting one throws a
  `FadenstackPairingAgentError` with `reason: "not_approved_or_redeemed"` (the same for an agent collected already).
  Before the approval it has `reason: "pending"`.
- A pairing with one agent sends exactly what it always did.

## Keep the sign-in

A `TokenStore` keeps the sign-in between runs. The default `MemoryTokenStore` keeps it only as long as the page or
process lives, so the user signs in again next time. To keep it longer, pass your own store:

```ts
import type { TokenSet } from "@fadenstack/client";

interface TokenStore {
  load(key: string): Promise<TokenSet | undefined>;
  save(key: string, tokens: TokenSet): Promise<void>;
  delete(key: string): Promise<void>;
}
```

The key names the backend and the agent, so one store can hold several sign-ins. The `TokenSet` holds the refresh
token: treat what the store keeps as a secret.

### In a browser extension

A browser extension keeps the sign-in in `chrome.storage`. This store works in the extension's service worker and its
pages (it needs the `storage` permission, and `@types/chrome` for the types):

```ts
import type { TokenSet, TokenStore } from "@fadenstack/client";

/** Keeps agent sign-ins in the extension's storage. */
export class ChromeStorageTokenStore implements TokenStore {
  readonly #area: chrome.storage.StorageArea;

  constructor(area: chrome.storage.StorageArea = chrome.storage.local) {
    this.#area = area;
  }

  async load(key: string): Promise<TokenSet | undefined> {
    const items = await this.#area.get(key);
    return items[key] as TokenSet | undefined;
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    await this.#area.set({ [key]: tokens });
  }

  async delete(key: string): Promise<void> {
    await this.#area.remove(key);
  }
}
```

```ts
const { client, tokens } = FadenstackClient.forAgent({
  serverUrl: "https://ai.example.internal",
  agent: "docs-assistant",
  store: new ChromeStorageTokenStore(),
});
```

`chrome.storage.local` keeps the sign-in across browser restarts, stored without encryption in the browser profile.
`chrome.storage.session` keeps it in memory until the browser closes. Pass `chrome.storage.session` to the constructor
if the user should sign in once per browser session.

A desktop or Node application can keep the sign-in in a file that only the user can read.

## Build the agent

`FadenstackAgent.createBuilder()` puts an agent together. The builder takes the client, your tools, who approves tool
calls, and where sessions live:

```ts
import { FadenstackAgent } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(readPage, deletePage)
  .useApprovals(async (request, signal) => askTheUser(request, signal)) // without it: declined
  .build();
```

| Method | What it does |
|---|---|
| `useClient(client)` | The client from `FadenstackClient.forAgent`. The agent is the client's agent. |
| `useServer(serverUrl, credentials, options?)` | Instead of `useClient`: the builder creates the client. Needs `useAgent`. |
| `useAgent(slug)` | The agent's slug or id. Not needed with `useClient`. |
| `addTools(...tools)` | Host tools, from `defineTool`. See [Tools and approvals](tools.md). |
| `addToolSource(source)` | Tools that are added once the agent's profile is known. A source that can change its tools while the agent runs is a `ChangingToolSource`. See [Tools from other sources](tools.md#tools-from-other-sources). |
| `useApprovals(handler)` | Who decides on tool calls that need approval. Without one, every such call is declined. |
| `useSessionStore(store)` | Where sessions live. By default the signed-in user's own IndexedDB database in a browser and memory elsewhere. See [Sessions on the device](sessions.md). |
| `useApprovalStore(store)` | Where "Allow always" is kept. By default the signed-in user's own IndexedDB database in a browser and memory elsewhere. See [Tools and approvals](tools.md#allow-always). |
| `useSessionRetention({ maxSessions, maxAgeDays })` | How many sessions, and how old, the default store keeps (50 and 90 days); the server's `local_retention` can only lower them. See [Retention](sessions.md#retention). |
| `useSecretProtector(protector)` | What encrypts the default stores: by default a non-extractable WebCrypto key per user in a browser, none elsewhere. See [Encryption](sessions.md#encryption). |
| `useStoreProblemHandler(handler)` | Told of a stored record that does not decrypt (the store and the kind, never contents). |
| `useStepUpHandler(handler)` | Who opens the second sign-in the server's Bypass needs: the verification page in the system browser or a new window, never an iframe (`browserStepUp()` for a web page). An approval handler with `open` and `report` is used when none is given. **Bypass is announced to the server, and so offered, only with one.** See [Server-held grants and Bypass](server-grants.md#bypass). |
| `useGrantHandler(handler)` | Who draws the grant card (the Bypass confirmation, the work card): `requestGrant(offer, signal)`. An approval handler that has it is used when none is given. |
| `useGrantPlaceResolver(resolver)` | Native, canonical resolution of the places a work grant covers; without it work grants cover nothing. See [Server-held grants and Bypass](server-grants.md#a-grant-for-a-stretch-of-work). |
| `usePermissionMode(mode)` | `ask` (the default), or `bypass`, which asks for the server's Bypass in your code: no card, the same second sign-in and grant. Where Bypass cannot be had, such sessions run in `auto` instead of `ask`. See [Tools and approvals](tools.md#bypass-mode). |
| `useDefaultToolMode(mode)` | A cap on the mode new sessions start in (the agent's default level from the server). It narrows, never widens. |
| `useMaxRounds(rounds)` | Model calls per turn before the loop stops. Default 16. |
| `useHistoryBudget(tokens)` | About how many tokens of history a request carries. Older turns are left out. Default 24 000. |
| `useReasoning(effort)` | How much a reasoning model thinks before it answers, when the person has not picked: `none`, `minimal`, `low`, `medium`, `high` or `xhigh` (the values of `ReasoningEffort`). Models without the setting ignore it. See [How long the agent thinks](#how-long-the-agent-thinks). |
| `useReasoningStore(store)` | Where the level of thinking a person picked is kept, per person and agent. By default the signed-in user's own IndexedDB database in a browser, and memory elsewhere. |
| `useEventReporting(enabled)` | Whether the agent reports its tool runs, approvals and the app's manifest to the server. Default on. |
| `useLogging(logger)` | Where the SDK logs: a `FadenstackLogger`. Names, ids, counts and durations, never content. Nowhere by default. See [Logging](#logging). |
| `requireHostToolPolicyChecks()` | Refuses to start against a server that does not offer the fresh policy check for host tools. See [Host commands and central policy](host-commands.md#requiring-the-check). |
| `describeApp(app)` | The application the agent runs in, for the manifest. See [Tools and approvals](tools.md#the-app-manifest). |
| `addChatStage(order, wrap)` | Wraps the chat, for example to mask what goes out. |
| `addToolStage(order, stage)` | Wraps each tool call: sees the arguments before and the result after. |
| `addToolService(key, factory)` | A service tools get per call by its key (`context.services.get(key)`), made by `factory` on the call's first use. One factory per key. |
| `use(module)` | Adds a module, which configures the builder. |

Stages sit at a `StageOrder` slot: `context` (100), `pii` (200), `provenance` (300) and `custom` (500). A lower number
is further from the server: a tool call passes the PII stage before the provenance stage, so the provenance stage
sees the arguments the tool gets.

A tool service's factory gets the call (`ToolServiceCall`): the tool, its class, its arguments, the ids of the call,
session and turn, the call's signal, the agent's client and profile, and `record(type, data)`, which adds an entry of
the module's own type (`provenance.placed`) to the session's transcript. A module's entries hold ids, names and
counts, never content; they are not sent to the model, and the SDK's own entry types are refused. `notice(notice)`
raises a notice on the turn for the user (the provenance module's `provenance_refused`): it goes into the turn's
notices and the transcript, as the .NET SDK's `ToolInvocation.NoticeAsync` does.

`build()` throws when the agent or the client is missing, when the client is for another agent, and when two tools
have the same name.

### Start the agent

The agent starts the first time you open a session, or when you call `agent.start()`. Starting:

- loads the agent's profile from the server: its name, version, model, host tool contract and tool modes, but never
  its instructions;
- checks that the builder has every module the profile requires, and throws a `FadenstackError` if not;
- settles the tools: host tools outside a non-empty contract are dropped, the others run under the stricter of your
  class and the contract's; without a contract, or for an entry without a `risk`, a tool is `unknown` and asks;
- warns once, on the console, when the app set bypass mode and the server does not offer Bypass for the agent, or the app opens
  no second sign-in (`useStepUpHandler`);
- reports the app's manifest to the server, unless event reporting is off.

After that, `agent.profile` is the `AgentProfile` and `agent.tools` lists the tools with the classes they run under.
When a new version of the agent is published, `agent.restart()` loads the profile again. `agent.profile.user.language` is the language the user picked for all their clients and the console, or `null`; `agent.setUserLanguage(tag)` keeps a new one (`null` forgets it). The chat panel does both: see [Languages](chat-panel.md#languages).

## Sessions

A session is one conversation, kept on the device:

```ts
const session = await agent.startSession();          // the agent's default level: "ask" unless set otherwise
const again = await agent.openSession(session.id);   // a session from this device's store
```

A session starts and opens with a profile no older than a minute: it is read again when it is older, so a ceiling an
administrator lowered reaches the next session without a restart. A chat whose Bypass grant still lives opens in
Bypass (`session.bypass` is the grant, with its time left); see [Server-held grants and Bypass](server-grants.md#bypass).
`agent.listSessions()`, `agent.listApprovals()` and `agent.resetApprovals()` are the signed-in user's own.

| Method | What it does |
|---|---|
| `agent.startSession(toolMode?)` | A new session, in the agent's default tool mode unless you give one. |
| `agent.openSession(sessionId)` | A session from the store, to continue in the mode it was last in. |
| `agent.listSessions()` | This agent's sessions on the device, newest first. |
| `agent.deleteSession(sessionId)` | Deletes a session from the store. |
| `agent.exportMyData()` | The signed-in user's sessions and approvals on this device as one decrypted JSON document. See [Export and delete my data](sessions.md#export-and-delete-my-data). |
| `agent.deleteMyData()` | Deletes the user's databases and their key; says when a store you passed was left. |

A session runs one turn at a time. Starting a second turn while one runs throws; `session.isRunning` says whether a
turn is running. See [Sessions on the device](sessions.md) for where sessions are kept and for how long.

## Stream a turn

`session.stream(message, options?)` sends a message and yields what happens, in order, until the turn ends:

```ts
for await (const e of session.stream("What is on page 7?")) {
  switch (e.type) {
    case "text": append(e.text); break;
    case "tool_started": showTool(e.name, e.source); break;
    case "notice": showNotice(e.notice.message); break;
    case "turn_completed": done(e.result.outcome); break;
  }
}
```

Every event has a `type` and the `turnId` of its turn:

| `type` | Fields | When |
|---|---|---|
| `turn_started` | `toolMode` | The turn begins. `toolMode` is the mode it runs in. |
| `text` | `text` | A piece of the answer. |
| `reasoning` | `text` | A piece of the model's reasoning, for models that report it. |
| `tool_started` | `callId`, `name`, `toolClass`, `source`, `arguments` | A tool starts. `source` is `host` for your tools, `mcp` for a tool from an MCP server, or `gateway` for a tool the server runs. For a server tool, `arguments` is empty: the server keeps them. |
| `tool_completed` | `callId`, `name`, `source`, `outcome`, `result`, `durationMs` | A tool ended. `outcome` is `ok`, `error`, `denied` or `cancelled`. The duration leaves out the time spent waiting for an approval. |
| `approval_requested` | `request` | A tool call waits for the user. Your approval handler is asked right after. |
| `approval_decided` | `request`, `decision` | The user decided, or no answer came in time. Calls that an approval for this chat, an approval kept always, or a grant let through are not asked, and send neither event. |
| `notice` | `notice` | A refusal or a limit, to show on the turn. See [Outcomes and errors](outcomes.md#notices). |
| `gateway_event` | `event` | An event from the server, as it arrived: citations, a PII notice, and others. |
| `turn_completed` | `result` | The turn ended. `result` is the `AgentResult`. |

`gateway_event` carries every event the server sent during the turn, including those the SDK acts on itself. Use it
for events the other types do not cover. Its `event` has the server's `type` (`TOOL_CALL_START`, `TOOL_CALL_END` or
`CUSTOM`), a `name` for a custom event (for example `faden.citations` or `faden.pii`), a `value`, and the whole event
as `raw`.

A turn that fails or is stopped yields no `turn_completed`: the stream throws instead. See
[Outcomes and errors](outcomes.md).

## Wait for the whole turn

`session.send(message, options?)` runs the turn and returns its `AgentResult` once it has ended:

```ts
const result = await session.send("Which pages show table T1?");
console.log(result.outcome, result.text);
```

It takes the same options as `stream` and throws the same errors.

## Stop a turn

Pass an `AbortSignal` to stop a turn:

```ts
import { isAbortError } from "@fadenstack/client";

const stop = new AbortController();
stopButton.addEventListener("click", () => stop.abort());

try {
  const result = await session.send("Summarise every page.", { signal: stop.signal });
  done(result.outcome);
} catch (error) {
  if (!isAbortError(error)) throw error;
  // Stopped. The turn is recorded as cancelled.
}
```

When the signal aborts, the request to the server is cancelled, running tools see their `context.signal` abort, and a
waiting approval is given up. The turn is recorded as cancelled and is left out of later requests. `stream` and `send`
throw the signal's reason; `isAbortError` tells it apart from a failure.

Leaving a `for await` loop over `stream` early, with `break` or `return`, also stops the turn and records it as
cancelled. Nothing is thrown then.

## Send context with a message

The user can attach context to a message: a selection, the page, a range of cells. Pass it as `attachments`:

```ts
const result = await session.send("Check this paragraph for errors.", {
  attachments: [{ title: "Selection", kind: "selection", content: selectedText }],
});
```

| Field | What it is |
|---|---|
| `title` | What the user sees, for example "Selection" or "example.com/pricing". |
| `content` | The text the model gets. Markdown by default. |
| `source` | Where it comes from, for example `page`. Optional. |
| `kind` | What it is: `selection`, `page`, `range`, `slide`, `document`. Optional. |
| `reference` | An id your tools can read the content by again, for example the rest of a truncated page. Optional. |
| `mediaType` | The content's media type. Default `text/markdown`. |

Attachments are sent with the message, ahead of its text, and kept with it in the session, so later turns still see
what the question was about.

## How long the agent thinks

The chat panel shows a "thinking" pill in its header, where the person picks how long the agent thinks before it
answers. The levels are `ReasoningLevel`: `auto`, `off`, `low`, `medium` and `high`. `off` goes on the wire as `none`.
The pick is kept per person and per agent on the device, in the signed-in user's own IndexedDB database
(`fadenstack-preferences:<tenant>:<user>`), and a change applies from the next message.

In code:

```ts
agent.reasoningChoices.levels; // the levels the agent offers, in menu order
agent.reasoningChoices.max;    // the most the server allows, or undefined
agent.reasoning;               // the level new messages think at
await agent.setReasoning("low"); // keeps the pick; undefined forgets it; a level the agent does not offer is ignored
session.reasoning = "high";      // this chat only, from the next message; a level above the maximum sends the maximum
```

In the view model the pill is `chat.reasoningOptions` (each with `level`, `label`, `description` and `selected`),
`chat.reasoningLevel`, `chat.selectedReasoning`, `chat.reasoningPillText`, `chat.reasoningToolTip`,
`chat.isReasoningMenuOpen` and `chat.setReasoningMenuOpen(open)`, and `await chat.selectReasoning(level)` takes the pick.
Both skins draw it. See [The chat panel](chat-panel.md).

### The server's maximum

The server can only set a maximum, in the agent version's `ui`:

```json
{ "reasoning": { "max": "low" } }
```

`max` is optional and is one of the gateway's names: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
Anything else is ignored, and the agent offers every level.

- The pill hides the levels above the maximum. Off is always offered.
- `minimal` lies between none and low. The SDK has no level there, so `minimal` caps at `none`: the pill offers Auto
  and Off.
- `max` is the top of the gateway's scale. It sets no cap.
- With a maximum, Auto means the maximum, and it is sent. Without one, Auto sends no field.
- A pick above a later, lower maximum shows and sends the maximum. The profile is read again at the start of a session
  once it is a minute old, so a maximum an administrator lowers reaches the next message.
- The order is: the person's pick, then `useReasoning`, then Auto, each lowered to the maximum.

`useReasoning` goes out as the app set it, so `xhigh` stays `xhigh`, unless the maximum is lower. The panel shows
`minimal` as Low and `xhigh` as High. `max` is not a value for `useReasoning`; it only names a server maximum.

The turn's start entry in the session records `reasoning_effort`: the effort the request carried, or `auto` when it
carried none.

## Logging

`useLogging(logger)` gives the agent a place to write what it does. A `FadenstackLogger` has one method,
`log(event: LogEvent)`:

```ts
import { consoleLogger } from "@fadenstack/client";

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .useLogging(consoleLogger("information")) // or { log: (event) => myLogger.write(event) }
  .build();
```

A `LogEvent` has a `category`, an `eventId`, an `eventName`, a `level` (`debug`, `information`, `warning` or `error`),
the `message` with its fields put in, the `fields` as a plain object, and the `scope` (`ConversationId`, `TurnId`) of a
turn's entries. The ids, names and field names are the .NET SDK's, so one dashboard reads both. There is no file sink in
a browser; forward the events to the logger your application has. `consoleLogger(minimum?, sink?)` writes them to a
console, for development. A logger that throws never fails a turn or a request. The default is no logging.

**Logs hold no content.** The SDK writes names, ids, counts, durations and outcomes. It never writes a prompt, an
answer, reasoning, attachment text, tool arguments or results, a token or a secret, or who the user is. A field is a
string, a number, a boolean or null: a structure is cut to its type name, and text is cut at 200 characters. The name of
a tool the model made up is logged as `(unknown)`.

The client gets the logger too, unless it has one: `useLogging` reaches a client made elsewhere. A client made with
`forAgent` or `new FadenstackClient` can take a `logger` option of its own.

| Category | Id | Event | Level |
|---|---|---|---|
| `Fadenstack.Client` | 1000, 1001 | `Request`, `RequestFailed` | information, warning |
| | 1010-1013 | `TokenRefreshed`, `TokenRefreshFailed`, `SignedOut`, `SignOutRevokeFailed` | information, warning |
| | 1020 | `EventSkipped` | warning |
| | 1030-1033 | `PairingStarted`, `PairingSlowedDown`, `PairingRetrying`, `PairingEnded` | information, warning |
| `Fadenstack.Agents` | 2000-2003 | `ProfileLoaded`, `ToolsSettled`, `ToolDropped`, `BypassMode` | information, warning |
| | 2009 | `ProfileRereadFailed` | warning |
| | 2010-2012 | `TurnStarted`, `TurnEnded`, `ModelRequest` | information, debug |
| | 2013, 2014 | `ToolsRefreshed`, `ToolsRefreshFailed` | information, warning |
| | 2020, 2021 | `ToolCall`, `Approval` | information |
| | 2030 | `Notice` | information |

The agent's events are the `AgentLog` entries of `@fadenstack/agents`; the client's are `ClientLog` in
`@fadenstack/client`. The .NET events about files on a disk (data export, adoption) have no use in a browser and are not
here.

## What the agent reports

With event reporting on, the agent tells the server what happened on the device: tool runs, approval decisions and
session counts. A report holds names, durations, outcomes and counts, never arguments, results or messages. Reports go
out after each turn. A report that fails is dropped and never fails the turn; `agent.lastReportError` holds the
last failure. Each approval is reported with what let the call through (`scope`: `once`, `chat`, `always` or
`grant`, which a grant for a time, a stretch of work or Bypass is), also when nobody was asked.

| Method | What it does |
|---|---|
| `session.close()` | Reports the session's counts and sends what is waiting. |
| `agent.flush()` | Sends what is waiting. |
| `agent.dispose()` | Sends what is waiting and disposes the tool sources. |

See [Sessions](../../concepts/sessions.md) for what the server keeps.
