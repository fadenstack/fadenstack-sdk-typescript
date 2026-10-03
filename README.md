# Fadenstack TypeScript SDK

Agents that run in a browser, a web page or Node and are governed by a [Fadenstack](https://fadenstack.github.io)
server. The SDK runs the agent loop on the device: tools, approvals and the conversation itself. The server owns the
agent's instructions, model and knowledge, and handles PII, budgets and audit. The first host is the Chrome drawer
([faden-agent-chrome](https://github.com/fadenstack/faden-agent-chrome)).

| Package | What it is | .NET |
|---|---|---|
| `@fadenstack/client` | The server connection: the gateway's chat completions (streamed, with the gateway's events), agent sign-in, the agent resource (profile, events, approvals), tool classes and modes, typed errors | `Faden.Client` |
| `@fadenstack/agents` | The agent: builder, the tool loop, tool classes and modes, approvals, local sessions, outcomes, stages and modules | `Faden.Agents` |
| `@fadenstack/ui` | Framework-free view models for a chat with an agent | `Faden.UI` |
| `@fadenstack/ui-react` | The React skin: a Copilot-style chat panel that looks like part of the browser | `Faden.UI.Wpf` |
| `@fadenstack/testing` | A fake Fadenstack server for tests and demos | — |

The packages are ES modules with type declarations, for browsers (Chrome 116+) and Node 20.19+. They use `fetch`,
Web Streams and Web Crypto and nothing else; the UI packages add `marked` (Markdown) and React.

## An agent

```ts
import { FadenClient, loginWithPassword } from "@fadenstack/client";
import { FadenAgent, defineTool } from "@fadenstack/agents";

const readPage = defineTool<{ page: number }>({
  name: "read_page",
  description: "Reads a page of the open schematic.",
  toolClass: "read",
  parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
  run: ({ page }) => schematic.page(page),
});

// One agent per client. Keep the sign-in where it lasts (a browser extension: chrome.storage; see TokenStore).
const { client, tokens } = FadenClient.forAgent({ serverUrl: "https://faden.plant.local", agent: "eplan-assistant", store });
if (!(await tokens.isSignedIn())) {
  const login = await loginWithPassword({ apiUrl: "https://faden.plant.local", email, password });
  await tokens.signIn(login, "EPLAN on PC-7"); // the login token is not kept
}

const agent = FadenAgent.createBuilder()
  .useClient(client)
  .addTools(readPage, deletePage)
  .useApprovals(async (request, signal) => askTheUser(request, signal)) // otherwise: declined
  .build();

const session = await agent.startSession(); // starts in "ask"
for await (const e of session.stream("What is on page 7?")) {
  switch (e.type) {
    case "text": append(e.text); break;
    case "tool_started": showTool(e.name, e.source); break;
    case "notice": showNotice(e.notice.message); break;
    case "turn_completed": done(e.result.outcome); break;
  }
}
```

`session.send(text)` waits for the whole turn and returns the `AgentResult`. An `AbortSignal` (`{ signal }`) stops a
turn; it is recorded as cancelled.

## Tool classes and tool modes

Every tool has a class: `read`, `write`, `destructive`, or `unknown` (nobody said). The user picks a mode per session
(`session.toolMode`):

| Mode | read | write | destructive | unknown |
|---|---|---|---|---|
| `off` | hidden | hidden | hidden | hidden |
| `read_only` | runs | hidden | hidden | hidden |
| **`ask`** (every session starts here) | runs | asks | asks | asks |
| `auto` | runs | runs | asks | asks |

- *hidden* tools are not offered to the model, and refused if it calls them anyway. *asks* goes to your approval
  handler; `ApprovalDecision.approveForSession()` stops asking for that tool in that session.
- The agent's host tool contract on the server can make a class stricter, never looser. Tools outside a non-empty
  contract are not offered.
- An EE ceiling narrows what the user may pick (`session.effectiveToolMode`).
- Arguments are checked against the tool's `parameters` before anyone is asked.

## Refusals are outcomes

A turn ends with an `AgentResult` whose `outcome` is `completed`, `prompt_blocked`, `response_blocked`, `tool_denied`,
`rate_limited` or `budget_exceeded`, with the notices to show. A refused prompt or answer is never sent to the model
again, and the session goes on. Only real failures throw (`FadenApiError` and its subclasses, `FadenStreamError`,
`FadenSignInRequiredError`).

## Sessions stay on the device

Each session is an append-only transcript (the same entry types as the .NET SDK). In a browser the default store is
IndexedDB, readable only by the extension or page that wrote it; it is not encrypted beyond what the browser does for
its profile -- unlike the .NET SDK's DPAPI on Windows, a browser has no per-user secret store to lean on. The newest
50 sessions are kept, none older than 90 days. Elsewhere sessions live in memory unless you pass a `SessionStore`.
The server keeps usage and events (tool names, durations, outcomes, approval decisions), never content.

## A chat panel (`@fadenstack/ui`, `@fadenstack/ui-react`)

The UI is split in two, and the split is strict:

- **`@fadenstack/ui`** holds all of the behaviour, as view models with no framework: the chat
  (`AgentChatViewModel`), turns, answer parts, the tool-mode picker, history, attachments, and an `ApprovalBroker`
  that turns approvals into cards. Each view model is observable (`subscribe`, `version`); collections are replaced,
  never changed in place. It is tested headless.
- **Skins only render.** `@fadenstack/ui-react` binds them with `useSyncExternalStore`. A Vue or Lit skin binds to
  the same view models.

```tsx
import { AgentChatViewModel, ApprovalBroker } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import "@fadenstack/ui-react/styles.css";

const approvals = new ApprovalBroker();               // approval cards in the chat decide
const agent = FadenAgent.createBuilder().useClient(client).addTools(...tools).useApprovals(approvals).build();
const chat = new AgentChatViewModel(agent, approvals);
await chat.initialize();
root.render(<ChatPanel chat={chat} />);
```

What it shows, as in GitHub Copilot's chat:

- The answer **streams as Markdown** -- headings, lists, code blocks with a copy button, tables, quotes, links -- built
  as React elements, never as HTML. Remote images are never loaded (a remote image can carry data out). Text and
  tool calls **interleave** in the order they happened.
- Each tool call is **one line** ("Running read_page", then "Ran read_page", its class and duration), expandable to
  its input and output. **Approvals are cards** with Allow, Allow for this chat, and Deny, above their tool's line.
- Refusals and limits are **notices**; a refused prompt is marked "Not sent", with *Edit and resend*. Citations, PII
  notices and reasoning are collapsible.
- The header has the **tool mode**, **history** and **new chat**; the composer has context **chips** (implicit ones,
  like the current page, can be switched off), Enter to send, Shift+Enter for a new line, Esc to stop.
- It **looks like part of the browser**: Chrome's Material surfaces and blue, the system UI font, native scroll bars
  and controls, and it follows the browser's light or dark setting as it changes (`theme="system"`, the default).
  Windows contrast themes get the system colours. Every colour is a CSS variable on `.fdn-chat`
  (`--fdn-accent`, `--fdn-bg`, ...) for hosts with their own look. All texts are in `UiStrings`
  (`AgentChatOptions.strings`) for other languages.

Built for long sessions: the agent's events reach the view models in **one batch per frame** (33 ms), with text
merged; a streamed answer **re-parses only its last block**, and each block is memoized, so one update re-renders one
block; turns out of view are not laid out (`content-visibility`); opened sessions show their **latest 30 turns** and
page in older ones.

## Testing without a server

```ts
import { FakeGateway, lastToolResults } from "@fadenstack/testing";

const gateway = new FakeGateway({
  agents: [{ slug: "eplan", contract: [{ name: "read_page", risk: "read" }] }],
  model: (request) => lastToolResults(request).size
    ? { text: "Page 7 shows motor M1." }
    : { toolCalls: [{ name: "read_page", arguments: { page: 7 } }] },
});
const { client, tokens } = FadenClient.forAgent({ serverUrl: gateway.serverUrl, agent: "eplan", fetch: gateway.fetch });
```

It answers sign-in, agent tokens (rotating, with replay detection), the profile, chat (streamed, with events,
refusals, gateway tools and approvals), event reports and approvals, and refuses what the real server refuses: tools
outside the contract, unknown event fields. `gateway.listen()` serves it over HTTP for a browser or another process.

## Build and test

```bash
npm install
npm test            # vitest, against the sources
npm run typecheck
npm run build       # each package's dist/
```

## License

Apache-2.0
