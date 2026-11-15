# Data on the device

This page lists everything the SDK keeps on a device, in one place: every IndexedDB database and storage key it
writes, what each holds, how it is protected, how long it is kept, and how a person exports or deletes it. It also says
what the server keeps in governed mode. The other pages link here instead of repeating it. The .NET SDK keeps the same
data in folders ([.NET: Data on the device](../dotnet/data-on-device.md)).

## Where the SDK writes

| Where the agent runs | What the SDK writes |
|---|---|
| A web page | IndexedDB databases of the page's origin, below. |
| A browser extension | The same, in the extension's own origin: its pages and its service worker share them. |
| Node, or anywhere without IndexedDB | Nothing. Sessions, "Allow always", the thinking level, skills, MCP servers and the provenance key live in memory for the run, and no encryption key is made. |

IndexedDB belongs to one origin: other websites and other extensions cannot read it. Clearing the site's data in the
browser, or removing the extension, deletes everything below. The SDK writes no cookies, no `sessionStorage`, no Cache
API or OPFS entries, and no files.

## A person's databases

Each person's data is in databases of their own, so two people in one browser profile never see each other's chats.
A database's name is its base name, the tenant and the user, each escaped (`userStoreName`):

- **Standalone** (`useEndpoint`, `useChatStreamer`): the standalone principal, tenant and user `standalone`, as in
  `fadenstack-sessions:standalone:standalone`; apart from any governed person's.
- **Governed:** the tenant and the user the server names in the agent's profile (`profile.principal`), as in
  `fadenstack-sessions:<tenant>:<user>`.
- **A server that names no user:** the base name alone (`fadenstack-sessions`), shared, as an older SDK kept it.

| Database (base name) | Package | What it holds | How it is protected | How long it is kept | Export and delete |
|---|---|---|---|---|---|
| `fadenstack-sessions` | `@fadenstack/agents` | The chats: each session's transcript, entry by entry, and a small list entry per session ([The transcript](sessions.md#the-transcript)). | Encrypted with the person's key (see [Encryption](sessions.md#encryption)); only the record keys stay in the clear: the agent, the session id and the sequence number. | The newest 50 sessions per agent, none older than 90 days; the others go when a new session starts. `useSessionRetention` and the server's `local_retention` lower the limits ([Retention](sessions.md#retention)). | Exported, decrypted; deleted. |
| `fadenstack-approvals` | `@fadenstack/agents` | "Allow always": each tool, its class, and when it was allowed. | Encrypted; the agent and the tool's name stay in the clear. | Until the person resets them (`resetApprovals`). | Exported; deleted. |
| `fadenstack-keys` | `@fadenstack/agents` | The person's AES-GCM key for the two databases above: a WebCrypto key that is not extractable. Script can use it, never read its bytes. | The browser's. | Until deleted; a new key is made afterwards. | Never exported; deleted, so a copy of the profile restored later can never be read. |
| `fadenstack-preferences` | `@fadenstack/agents` | How long the person lets each agent think. | Not encrypted. | Until the person changes it. | Not exported; deleted. |
| `fadenstack-skills` | `@fadenstack/skills` | The person's own skills ([Skills](skills.md)). | Not encrypted. | Until the person deletes a skill in the editor. | Not exported (the editor exports a skill as a zip); deleted. |
| `fadenstack-skill-switches` | `@fadenstack/skills` | The skills the person turned off. | Not encrypted. | Until the person changes it. | Not exported; deleted. |
| `fadenstack-mcp` | `@fadenstack/mcp` | The person's own MCP servers: the address, on or off, the trust mark, the person's raises, the local-network switch, and the header names and values. Beside them, the device's audit log of that switch: the time, the server's origin, on or off, the warning's version and the person ([Local MCP servers](local-mcp.md)). | The header values are sealed with the person's key; the rest is not encrypted. | The servers: until the person removes one. The audit log: the newest 500 lines. | Not exported; deleted. |
| `fadenstack-provenance` (standalone) | `@fadenstack/provenance` | The device's signing key, the signed provenance records with their time-stamps, and the log of placements: hashes, the media type and the kind of edit, never the content ([Marking AI-generated content](provenance.md)). | The key is a WebCrypto key that is not extractable; the records and the log are not encrypted. | The key and the records: until deleted. The log: the newest 2,000 entries. | Not exported (`keptRecords()` and `placements()` read them); deleted. |

In governed mode the server signs and keeps the provenance records, so nothing of provenance is written to the person's
databases.

Earlier TypeScript versions wrote the sessions and "Allow always" as plain records. The first time a database is
opened with a key, they are read once and written back encrypted. Where the page has no WebCrypto (an insecure page),
the stores keep plain records.

## Shared by the origin

Two helpers of `@fadenstack/ui-web` keep a chat panel's choices in the browser's `localStorage`, when the app uses them.
They are not per person: every panel of the site or extension shares them.

| Key | Written by | What it holds | Export and delete |
|---|---|---|---|
| `fadenstack.language`, `fadenstack.unmarkedNotice` | `browserPreferences()` | The language picked in the panel; the notice for an answer without an AI mark ([The chat panel](chat-panel.md)). | Not in `exportMyData` or `deleteMyData`. |
| `fadenstack.prompts` | `browserPromptStore()` | The person's saved prompts. | Not in `exportMyData` or `deleteMyData`. |

Where there is no `localStorage`, or the browser refuses a write, they keep the choice in memory.

## There is no older shared store to move

From a server that names no user the SDK goes on using the shared databases an older SDK kept (`fadenstack-sessions`,
`fadenstack-approvals`). It never moves what is kept there to a person: in a browser profile nobody can say whose it is.
The .NET SDK moves its shared folders once, to the first person a server names.

## Export and delete

A person can ask for the data a device holds about them (GDPR Art. 15 and 20) and for its deletion (Art. 17).
[Export and delete my data](sessions.md#export-and-delete-my-data) shows the calls.

| Call | What it covers | What it leaves |
|---|---|---|
| `agent.exportMyData()` | One JSON document with the person's sessions, decrypted, and their "Allow always" approvals. | Tokens and secrets, which are never exported; the thinking level; skills and their switches; the MCP servers and their audit log; the standalone provenance records and log; the `localStorage` keys; what the server keeps. |
| `agent.deleteMyData()` | The person's databases, all eight, their key with them. Afterwards the stores start empty, with a new key. From a server that names no user: the shared databases. | The sign-in (sign out for that); the `localStorage` keys; another person's databases (deleting a governed person's data leaves the standalone principal's, and the other way round); a store your app passed (`hostStoresLeft`); what the server keeps. |
| `tokens.signOut()` | Revokes the sign-in on the server where it can be reached, and deletes it from the token store. | The person's databases. |
| `agent.deleteSession(id)`, `agent.resetApprovals()` | One session; this agent's "Allow always". | |

`deleteMyData()` throws when a database stays open in a tab that does not close it; the SDK's own tabs close theirs on
request.

## What your app keeps

- **The sign-in.** The SDK keeps it in memory only (`MemoryTokenStore`). To keep it longer, your app passes a
  `TokenStore`: over `chrome.storage.local` or `chrome.storage.session` in an extension, over a file only the user can
  read in Node ([Hosting](hosting.md)).
- **A store you pass** (`useSessionStore`, `useApprovalStore`, `useReasoningStore`, your own `SecretProtector`) is
  yours: the SDK neither exports nor deletes it, and `hostStoresLeft` says so.
- **The connection wizard** keeps nothing itself. Your app keeps the connection (`ConnectionStore`: the server or the
  endpoint, never a key or token) and the endpoint's key (`EndpointKeyStore`); see [Connecting an agent](connecting.md).
  The wizard's sign-out (`ConnectionStore.signOut(deleteLocalChats)`) lets the person choose whether their chats go too.
- **The standalone language.** The SDK keeps it in memory for the run; your app passes a `languageStore` to keep it
  longer. In governed mode the server keeps it.
- **The machine policy** is your app's to read, from `chrome.storage.managed` in an extension; the SDK never writes it
  ([Machine policy](machine-policy.md)).
- **Logs** go to your logger only; the SDK keeps no log in storage ([Logging](agent.md#logging)).
- **A host app** may keep its own settings, in `chrome.storage` or elsewhere. The app's own documentation describes
  them.

## What the server keeps in governed mode

The conversation stays on the device. The server keeps usage and governance data, never the conversation's content:

- **Model requests** pass through the server's gateway on their way to the model, where the organisation's policies
  apply ([Personal data](../../concepts/personal-data.md)), and are counted for usage.
- **The agent's events,** with the session's id: `tool.executed` (the tool, its source, its duration and outcome),
  `approval.decided` (the tool, the decision, how long the person took, what let it through), `session.stats`
  (counts, and the retention in force), `local_mcp.attached` (an MCP server's label, its address without a user,
  password, query or fragment, and its tools' names) and `local_mcp.plain_http` (an MCP server's origin, and whether its
  local-network switch is on, where the profile's features list `client_events.local_mcp_plain_http`).
- **The app manifest:** the app's name and version, the SDK's version, the host tools with their classes, and the
  context and greeting the app describes ([The app manifest](tools.md#the-app-manifest)).
- **The person's settings,** such as their language, and the device's sign-in with its label, until it is revoked.
- **Server-held grants,** with their time limits ([Server-held grants and Bypass](server-grants.md)).
- **Provenance records:** what the server signs for content a tool places (content hashes, the media type, the kind of
  edit and the receipt, never the content) and the placement reports ([Marking AI-generated content](provenance.md)).

`useEventReporting(false)` stops the events and the manifest. What the server keeps is for its operator to export or
erase: the SDK's export and deletion cover the device only. [Sessions](../../concepts/sessions.md) explains what the
server keeps.

In standalone mode no Fadenstack server takes part. The chat goes to the endpoint the person chose and a tool call to
its tool; where the machine policy allows it, a provenance record's signature hash goes to the time-stamp authority.
Nothing else leaves the device.

## No long-term memory yet

The agent keeps no memory of the person beyond the chat itself: nothing from one session reaches another, on the device
or on the server, and each request carries its own session's history only.

OWASP ASVS 5.0: V11 (cryptography), V14 (data protection), V16 (security logging).
