# Build an agent

Connect to the server, sign in to an agent, build it with your tools, and run turns in a session.

## The client

A `FadenClient` is the connection to a Fadenstack server. For an agent, create it with `FadenClient.forAgent`, which
returns the client and the sign-in that goes with it:

```ts
import { FadenClient } from "@fadenstack/client";

const { client, tokens } = FadenClient.forAgent({
  serverUrl: "https://ai.example.internal",
  agent: "eplan-assistant",
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
  await tokens.signIn(login, "EPLAN on PC-7"); // the login token is not kept
}
```

`loginWithPassword({ apiUrl, email, password, fetch?, signal? })` returns the user's login token. Wrong credentials
throw a `FadenApiError` with the code `LOGIN_BAD_CREDENTIALS`.

`signIn(loginToken, deviceLabel?, signal?)` creates the sign-in for this device and keeps it in the token store. The
login token itself is not kept: hold it only as long as the sign-in takes. The server refuses the sign-in with a
`FadenPermissionError` (403) when the user has no grant for the agent.

The device label is what administrators see in the agent's list of sign-ins, for example the application and the
computer. It is cut to 200 characters. After signing in, `tokens.deviceId` is the id the server lists and revokes the
sign-in by.

The sign-in is a short-lived access token and a refresh token. The SDK renews the access token before it expires, and
the server replaces the refresh token on every renewal. Requests that need a token at the same time share one renewal.
When the server refuses the renewal (the sign-in was revoked, its refresh token was used twice, or the user lost access
to the agent), the SDK forgets the sign-in and throws a `FadenSignInRequiredError`. Sign in again.

| Method | What it does |
|---|---|
| `isSignedIn()` | Whether a sign-in is kept that can still be renewed. |
| `signIn(loginToken, deviceLabel?, signal?)` | Signs in this device and keeps the sign-in. Returns the `TokenSet`. |
| `signOut()` | Forgets the sign-in on this device. It does not end the sign-in on the server: an administrator does that among the agent's sign-ins in the console. |
| `getAccessToken(signal?)` | A valid access token, renewed if needed. The client calls this for you. |

See [Your first agent](../../get-started/first-agent.md) for registering the agent and granting it to users.

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
const { client, tokens } = FadenClient.forAgent({
  serverUrl: "https://ai.example.internal",
  agent: "eplan-assistant",
  store: new ChromeStorageTokenStore(),
});
```

`chrome.storage.local` keeps the sign-in across browser restarts, stored without encryption in the browser profile.
`chrome.storage.session` keeps it in memory until the browser closes. Pass `chrome.storage.session` to the constructor
if the user should sign in once per browser session.

A desktop or Node application can keep the sign-in in a file that only the user can read.

## Build the agent

`FadenAgent.createBuilder()` puts an agent together. The builder takes the client, your tools, who approves tool
calls, and where sessions live:

```ts
import { FadenAgent } from "@fadenstack/agents";

const agent = FadenAgent.createBuilder()
  .useClient(client)
  .addTools(readPage, deletePage)
  .useApprovals(async (request, signal) => askTheUser(request, signal)) // without it: declined
  .build();
```

| Method | What it does |
|---|---|
| `useClient(client)` | The client from `FadenClient.forAgent`. The agent is the client's agent. |
| `useServer(serverUrl, credentials, options?)` | Instead of `useClient`: the builder creates the client. Needs `useAgent`. |
| `useAgent(slug)` | The agent's slug or id. Not needed with `useClient`. |
| `addTools(...tools)` | Host tools, from `defineTool`. See [Tools and approvals](tools.md). |
| `addToolSource(source)` | Tools that are added once the agent's profile is known. |
| `useApprovals(handler)` | Who decides on tool calls that need approval. Without one, every such call is declined. |
| `useSessionStore(store)` | Where sessions live. By default IndexedDB in a browser and memory elsewhere. See [Sessions on the device](sessions.md). |
| `useDefaultToolMode(mode)` | The mode new sessions start in. It can only be stricter than `ask`. |
| `useMaxRounds(rounds)` | Model calls per turn before the loop stops. Default 16. |
| `useHistoryBudget(tokens)` | About how many tokens of history a request carries. Older turns are left out. Default 24 000. |
| `useReasoning(effort)` | How much a reasoning model thinks before it answers: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`. Models without the setting ignore it. |
| `useEventReporting(enabled)` | Whether the agent reports its tool runs, approvals and the app's manifest to the server. Default on. |
| `describeApp(app)` | The application the agent runs in, for the manifest. See [Tools and approvals](tools.md#the-app-manifest). |
| `addChatStage(order, wrap)` | Wraps the chat, for example to mask what goes out. |
| `addToolStage(order, stage)` | Wraps each tool call: sees the arguments before and the result after. |
| `use(module)` | Adds a module, which configures the builder. |

`build()` throws when the agent or the client is missing, when the client is for another agent, and when two tools
have the same name.

### Start the agent

The agent starts the first time you open a session, or when you call `agent.start()`. Starting:

- loads the agent's profile from the server: its name, version, model, host tool contract and tool modes, but never
  its instructions;
- checks that the builder has every module the profile requires, and throws a `FadenError` if not;
- settles the tools: host tools outside a non-empty contract are dropped, the others run under the stricter of your
  class and the contract's;
- reports the app's manifest to the server, unless event reporting is off.

After that, `agent.profile` is the `AgentProfile` and `agent.tools` lists the tools with the classes they run under.
When a new version of the agent is published, `agent.restart()` loads the profile again.

## Sessions

A session is one conversation, kept on the device:

```ts
const session = await agent.startSession();          // starts in "ask"
const again = await agent.openSession(session.id);   // a session from this device's store
```

| Method | What it does |
|---|---|
| `agent.startSession(toolMode?)` | A new session, in the agent's default tool mode unless you give one. |
| `agent.openSession(sessionId)` | A session from the store, to continue in the mode it was last in. |
| `agent.listSessions()` | This agent's sessions on the device, newest first. |
| `agent.deleteSession(sessionId)` | Deletes a session from the store. |

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
| `approval_decided` | `request`, `decision` | The user decided, or no answer came in time. |
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
const result = await session.send("Which pages show motor M1?");
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

## What the agent reports

With event reporting on, the agent tells the server what happened on the device: tool runs, approval decisions and
session counts. A report holds names, durations, outcomes and counts, never arguments, results or messages. Reports go
out after each turn. A report that fails is dropped and never fails the turn; `agent.reporter.lastError` holds the
last failure.

| Method | What it does |
|---|---|
| `session.close()` | Reports the session's counts and sends what is waiting. |
| `agent.flush()` | Sends what is waiting. |
| `agent.dispose()` | Sends what is waiting and disposes the tool sources. |

See [Sessions](../../concepts/sessions.md) for what the server keeps.
