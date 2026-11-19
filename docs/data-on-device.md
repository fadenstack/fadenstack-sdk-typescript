# Data on the device

This page lists everything the SDK keeps on a device, in one place: every IndexedDB database and storage key it
writes, what each holds, how it is protected, how long it is kept, and how a person exports or deletes it. It also says
what the server keeps in governed mode. The other pages link here instead of repeating it. The .NET SDK keeps the same
data in folders ([.NET: Data on the device](../dotnet/data-on-device.md)).

## Where the SDK writes

| Where the agent runs | What the SDK writes |
|---|---|
| A web page | IndexedDB databases of the page's origin, below, and `localStorage` keys of the chat helpers. |
| A browser extension | The same, in the extension's own origin: its pages and its service worker share them. |
| Node, or anywhere without IndexedDB | Nothing. Sessions, "Allow always", the thinking level, skills, MCP servers and the provenance key live in memory for the run, and no encryption key is made. |

IndexedDB belongs to one origin: other websites and other extensions cannot read it. Clearing the site's data in the
browser, or removing the extension, deletes everything below. The SDK writes no cookies, no `sessionStorage`, no Cache
API or OPFS entries, and no files.

## A person's databases

Each person's data is in databases of their own, so two people in one browser profile never see each other's chats.
A database's name is its base name, the tenant and the user, each escaped (`userStoreName`):

- **Standalone** (`useEndpoint`, `useChatStreamer`): the standalone principal, tenant and user `standalone`, as in
  `fadenstack-sessions:standalone:standalone`; apart from any governed person's. A governed server that names both tenant and user `standalone` gets `fadenstack-sessions:standalone:governed:standalone`: the client puts `governed:` in front of that user id, and the colon stays unescaped, which no other id can make (`encodeURIComponent` escapes a colon).
- **Governed:** the tenant and the user the server names in the agent's profile (`profile.principal`), as in
  `fadenstack-sessions:<tenant>:<user>`.
- **A server that names no user:** the base name alone (`fadenstack-sessions`), shared, as an older SDK kept it.

| Database (base name) | Package | What it holds | How it is protected | How long it is kept | Export and delete |
|---|---|---|---|---|---|
| `fadenstack-sessions` | `@fadenstack/agents` | The chats: each session's transcript, entry by entry, and a small list entry per session ([The transcript](sessions.md#the-transcript)). | Encrypted with the person's key (see [Encryption](sessions.md#encryption)); only the record keys stay in the clear: the agent, the session id and the sequence number. | By default the newest 50 sessions per agent, none older than 90 days; the others go when the agent starts, when a new session starts, and when the person turns deletion on or lowers a limit. In standalone the person can change the limits or turn deletion off (`fadenstack-preferences`, below), and the machine policy can fix them; in governed mode the server's `local_retention` and `useSessionRetention` decide ([Retention](sessions.md#retention)). | Exported, decrypted; deleted. |
| `fadenstack-approvals` | `@fadenstack/agents` | "Allow always": each tool, its class, and when it was allowed. | Encrypted; the agent and the tool's name stay in the clear. | Until the person resets them (`resetApprovals`). | Exported; deleted. |
| `fadenstack-keys` | `@fadenstack/agents` | The person's AES-GCM key for the two databases above: a WebCrypto key that is not extractable. Script can use it, never read its bytes. | The browser's. | Until deleted; a new key is made afterwards. | Never exported (a key); deleted, so a copy of the profile restored later can never be read. |
| `fadenstack-preferences` | `@fadenstack/agents` | How long the person lets each agent think (the `reasoning` store), and, in standalone mode, the person's choice for old chats (the `retention` store, one row: `{ id: "chat", autoDelete, maxAgeDays: 1 to 3650, maxSessions: 1 to 10000 }`; no chat text; not read in governed mode, where the server decides, nor where the machine policy fixes it; a damaged or out-of-range row counts as no choice). Version 2 added `retention` to databases made before. | Not encrypted. | Until the person changes it. | Exported as the records are; deleted. |
| `fadenstack-apps` | `@fadenstack/agents` | Which apps use the person's data: one record per app, `{ app, displayNames?, agents, firstSeen, lastSeen }` (the app's name, its display names in the panel's languages when it gave them, the agent slugs that ran under it, and two times), written at each agent start, never any content ([Export and delete](#export-and-delete)). Not written where the host passes both its own stores. | Not encrypted. | Until the app's data is removed. | Exported as the records are; deleted. |
| `fadenstack-audit` | `@fadenstack/agents` | The record of tool calls: an `entries` store (one row per tool call, keyed by its number) and a `meta` store (the seal key, the anchor a prune leaves and the sealed head). Each entry holds the tool's name and class, who or what let it run, the outcome and a hash of the arguments, never the prompt, the answer, the arguments or the result ([The record of tool calls](audit-log.md)). Every Fadenstack app and tab of the person in this origin appends to the same database; each entry links to the one before by a hash. Durable for every agent, whatever stores the host passed; in memory only where there is no IndexedDB, or where the app passes a `MemoryAuditLog` on purpose. | Entries and key sealed with the person's key (AES-GCM, bound to the database and the entry's number); the entries are also chained and sealed with the key in `meta`. | 180 days by default, or the machine policy's `auditRetentionDays` (30 to 3650); older entries go at the start and at most once a day, and the last removed one stays in the anchor. | Exported as `auditLog` (a CSV with its verification on top) and by `exportAudit("csv" or "html")`. Shared data: deleted with "Remove all", or with this app's data when no other app uses the person's data. |
| `fadenstack-skills` | `@fadenstack/skills` | The person's own skills ([Skills](skills.md)). The skills module learns whose they are from the agent's profile when the agent first asks for tools, whatever the policy says (local skills off included; standalone: the standalone principal). Before that its list holds the bundled skills only and a change is refused (`SkillsPersonUnknownError`: "Whose skills these are is not known yet: start the agent first"), so no skill reaches the wrong person's database. | Not encrypted. | Until the person deletes a skill in the editor. | Exported as the records are (the editor also exports a skill as a zip); deleted. |
| `fadenstack-skill-switches` | `@fadenstack/skills` | The skills the person turned off. | Not encrypted. | Until the person changes it. | Exported as the records are; deleted. |
| `fadenstack-web-search` | `@fadenstack/agents` (`webSearchModule`) | The person's web search provider (Brave or SearXNG), the SearXNG address, and the Brave key ([Pictures and web search](web-search.md)). | The key is sealed with the person's key; the rest is not encrypted. | Until the person changes it. | The settings exported, never the key; deleted. |
| `fadenstack-log` | `@fadenstack/agents` (`useBrowserLog`) | The SDK's own log entries: an `entries` store, one row per entry: the `LogEvent` (`category`, `eventId`, `eventName`, `level`, `message`, `fields`, `scope`) and `at` (ISO time). Names, ids, counts, durations and outcomes; never a prompt, an answer, an argument or a result ([A log in the browser](agent.md#a-log-in-the-browser)). Only where the app switches it on. Entries before the person is known are in `fadenstack-log` (no person) and stay there. | Not encrypted: it holds no content. | At most 500 entries and 7 days by default (`maxEntries`, `maxAgeDays`); the oldest go first. | Exported as `log`; deleted with the person's data (all of it also removes the one without a person). Shared data: with this app's data only when no other app uses the person's data. |
| `fadenstack-mcp` | `@fadenstack/mcp` | The person's own MCP servers: the address, on or off, the trust mark, the person's raises, the local-network switch, and the header names and values. Beside them, the device's audit log of that switch: the time, the server's origin, on or off, the warning's version and the person ([Local MCP servers](local-mcp.md)). | The header values are sealed with the person's key; the rest is not encrypted. | The servers: until the person removes one. The audit log: the newest 500 lines. | Exported without the sealed header values: per server the label, the address without user, password, query and fragment, on or off, the trust mark, the raises, the time limit, where it was imported from, whether it was reviewed, the local-network switch and the header names (a field not on that list stays out); the audit log as it is. Deleted. |
| `fadenstack-provenance` (standalone) | `@fadenstack/provenance` | The device's signing key, the signed provenance records with their time-stamps, and the log of placements: hashes, the media type and the kind of edit, never the content ([Marking AI-generated content](provenance.md)). | The key is a WebCrypto key that is not extractable; the records and the log are not encrypted. | The key and the records: until deleted. The log: the newest 2,000 entries. | The records and the log are exported (`keptRecords()` and `placements()` read them too); the key never is. Deleted. |

In governed mode the server signs and keeps the provenance records, so nothing of provenance is written to the person's
databases.

Earlier TypeScript versions wrote the sessions and "Allow always" as plain records. The first time a database is
opened with a key, they are read once and written back encrypted. Where the page has no WebCrypto (an insecure page),
the stores keep plain records.

## A person's `localStorage` keys

Two helpers of `@fadenstack/ui-web` keep a chat panel's choices in the browser's `localStorage`, when the app uses them. They
are per person: the key carries the principal as `userStoreName` writes it (`userLocalKey`, in `@fadenstack/agents`), as in
`fadenstack.prompts:<tenant>:<user>`, and the standalone principal is its own person (`...:standalone:standalone`). The chat
tells them whose they are (the principal of the agent's profile, once the agent has started) and they follow a sign-in as
another person; until then they read nothing and a prompt is not saved. A server that names no user keeps the one shared key
(`fadenstack.prompts`), as an older SDK did.

| Key | Written by | What it holds | Export and delete |
|---|---|---|---|
| `fadenstack.language:<person>`, `fadenstack.unmarkedNotice:<person>` | `browserPreferences()` | The language picked in the panel; the notice for an answer without an AI mark ([The chat panel](chat-panel.md)). | Exported (`localStorage`); deleted and counted in `storesCleared`. |
| `fadenstack.prompts:<person>` | `browserPromptStore()` | The person's saved prompts. | Exported (`localStorage`); deleted and counted in `storesCleared`. |

Where there is no `localStorage`, or the browser refuses a write, they keep the choice in memory. Earlier versions kept these
three under the shared keys above for everyone in the browser profile. The standalone principal reads the shared key while it
has none of its own (the choices were made by the one person of a standalone app) and writes its own on the next change; the
shared key is left alone, and `deleteMyData` removes it for the standalone principal too, so that a deletion is not undone by the
next read. Another person never adopts it.

## There is no older shared store to move

From a server that names no user the SDK goes on using the shared databases an older SDK kept (`fadenstack-sessions`,
`fadenstack-approvals`). It never moves what is kept there to a person: in a browser profile nobody can say whose it is.
The .NET SDK moves its shared folders once, to the first person a server names.

## Export and delete

A person can ask for the data this browser holds about them (GDPR Art. 15 and 20) and for its deletion (Art. 17).
[Export and delete my data](sessions.md#export-and-delete-my-data) shows the calls. Several Fadenstack apps can share one person's
data in a browser profile (the databases above are per person, not per app), so both calls take a scope:

- **`thisApp`, the default since 0.3.0:** "Remove my data…" removes only the calling app's data. The export holds exactly what that
  removal would remove.
- **`allApps`:** "Remove all my Fadenstack data in this browser" removes the person's whole data, as `deleteMyData()` did before
  0.3.0. The export holds all of it. The app can list the apps it affects first (`agent.myDataApps()`).

**An app** is the name the host gave it (`describeApp`), or, when it did not, the agent's slug; its **agents** are the slugs that
ran under it. Each agent start records, in the person's `fadenstack-apps` database, `{ app, displayNames?, agents, firstSeen, lastSeen }`: names (`displayNames` only where the host gave
them) and times, no content. A record is written only where the SDK keeps the person's databases (not where the host passes both its own
stores, and not for a server that names no user).

**What `thisApp` takes:** the sessions of this app's agents, their "Allow always", their entries in the thinking levels
(`fadenstack-preferences`, `reasoning`), and this app's record. An agent that another app's record also names is never touched: its
data stays and the result says so (`agentsKept`).

**What counts as shared** (and goes only when no other app uses it): the person's skills and skill switches, the MCP servers, the web
search settings, the provenance database, the record of tool calls (`fadenstack-audit`), the log of the SDK's own entries (`fadenstack-log`), the person's other preferences (old chats, language), their `localStorage` keys and the
person's data key (`fadenstack-keys`). Deleting that key makes everything encrypted under it unreadable, so it goes last, and only
when nothing of another app remains. (The .NET SDK has an approvals seal key that goes with the last approvals; here the approvals are
sealed under the person's data key, so there is no separate key.)

**"Another app uses the person's data"** means: another app record exists, or an agent has sessions, "Allow always" or a thinking level
that no record names. An app on an older SDK writes no record, so it is inferred from its data and named by its agent; it keeps the
shared data (the safe side). When no other app uses the data, `thisApp` removes everything, the key included, as `allApps` does.

| Call | What it covers | What it leaves |
|---|---|---|
| `agent.exportMyData({ scope })` | One JSON document (`format` and `version` 1; the newer fields are optional), `scope` and `app` said in it. `allApps`: everything the deletion removes, without secrets: the person's sessions, decrypted, and their "Allow always" approvals; `databases`: the app records, the preferences, skills and switches as the records are, the provenance records and placement log, the MCP servers (without header values, the address without user, password, query and fragment) and their audit log, each read by an allowlist per database and object store; `localStorage`: the person's keys. `thisApp` while other apps use the data: only this app's agents' sessions and approvals, its record and its agents' thinking levels, and `notIncluded` names what stayed and for which apps (`otherApps`, `agentsKept`). A row that is not plain JSON data is counted in `counts.unreadable`, not exported. | Tokens and secrets, never exported; the `fadenstack-keys` database and the provenance signing key; the MCP header values; what the server keeps. |
| `agent.deleteMyData({ scope })` | `allApps`: the person's databases, their key with them (and the log kept before anybody signed in), and their `localStorage` keys (`storesCleared` counts both). Afterwards the stores start empty, with a new key. `thisApp`: as above; `storesCleared` counts the chats of an agent, its approvals, its thinking level and the record that went. The person's browser log (`useBrowserLog`) goes with either scope. The result says `scope`, `otherApps` (the apps for which the shared data stayed), `sharedDataKept` and `agentsKept`. From a server that names no user: `thisApp` takes this agent's chats, approvals and thinking level from the shared databases; `allApps` the shared databases and keys. | The sign-in (sign out for that); another person's databases (deleting a governed person's data leaves the standalone principal's, and the other way round); a store your app passed (`hostStoresLeft`); what the server keeps. |
| `agent.myDataApps()` | The apps that use the person's data, this app first: `name`, `agents`, `lastSeen`, `isThisApp`, and `recorded` (false: an older app, inferred from an agent's data and named by that agent). | |
| `tokens.signOut()` | Revokes the sign-in on the server where it can be reached, and deletes it from the token store. | The person's databases. |
| `agent.deleteSession(id)`, `agent.resetApprovals()` | One session; this agent's "Allow always". | |

**The default changed in 0.3.0:** `exportMyData()` and `deleteMyData()` without a scope used to cover every app; they now cover
this app. Pass `{ scope: "allApps" }` for the old behaviour. An `AbortSignal` as the only argument still works (and means
`thisApp`).

`deleteMyData()` throws when a database stays open in a tab that does not close it; the SDK's own tabs close theirs on
request. A removal of `thisApp` that leaves the other apps' data opens no database of theirs for deletion, so it is not blocked
by their tabs.

The `MyDataSettingsViewModel` in `@fadenstack/ui` (with `MyDataSettings` in `@fadenstack/ui-react` and `@fadenstack/ui-vue`) is the
"Your data in this browser" control for an app's settings: Export my data, Remove my data…, Export all my Fadenstack data, Remove all
my Fadenstack data in this browser…. Each removal asks first in the control (for this app: what goes and, when other apps use shared
data, that skills, MCP servers, keys and provenance records stay because they are used by those apps; for all: the apps it
affects), then shows a result line. An export raises `onSaveRequest` with a suggested file name and the document as a `Blob`; the
app chooses where it goes. The control also shows a line about the person's record of tool calls ("Record of tool calls: 12 entries
since 01/08/2026, intact", or "damaged at entry 8") and "Export the record of tool calls…", which raises `onSaveRequest` with the
record as one web page (`kind: "audit"`, `text/html`).

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
