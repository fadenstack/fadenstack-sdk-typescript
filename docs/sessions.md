# Sessions on the device

Conversations are kept on the device, in a session store you can choose or replace.

A session is an append-only transcript. Each request to the server is built from it on the device; the server keeps
usage and events (tool names, durations, outcomes, approval decisions), never the content. See
[Sessions](../../concepts/sessions.md) for what the server keeps.

## Where sessions live

The builder picks a store unless you pass one with `useSessionStore`:

| Where the agent runs | Default store | Kept |
|---|---|---|
| A browser: a web page, or an extension's pages and service worker | `IndexedDbSessionStore` | In the browser's IndexedDB, until deleted or past the retention limits |
| Anywhere without IndexedDB, such as Node | `MemorySessionStore` | In memory, until the page or process ends |

### IndexedDB in a browser

`IndexedDbSessionStore` keeps each agent's sessions in an IndexedDB database named `fadenstack-sessions`: the
transcript entry by entry, and a small list entry per session so the history opens without reading every transcript.
An agent that keeps its sessions itself uses a database of the signed-in user (`fadenstack-sessions:<tenant>:<user>`),
so two people in one browser profile never see each other's; against a gateway that names no user it uses the plain
name, as an older SDK did, and it never moves what is kept there to a user. A store you pass yourself is used as it is.

What this protects, and what it does not:

- IndexedDB belongs to one origin. Other websites and other extensions cannot read the sessions.
- The sessions are encrypted (see [Encryption](#encryption)): a copy of the browser profile, a backup of it, or a file
  found on disk holds ciphertext only. Script that runs in your origin can still ask the SDK for the sessions: it can use
  the key, though not read it. For a web page, that includes every page of the same site.
- Clearing the site's data in the browser, or removing the extension, deletes the sessions.

### Encryption

The stores the SDK keeps in IndexedDB (sessions and "Allow always") are encrypted with AES-GCM, the way the .NET SDK
protects its files with DPAPI or the OS key store (`ISecretProtector`). The TypeScript form is the browser's:

| | .NET | TypeScript |
|---|---|---|
| The key | DPAPI (Windows) or the OS key store | A WebCrypto key, **not extractable**, one per signed-in user, in a database of its own (`fadenstack-keys:<tenant>:<user>`) as a `CryptoKey` object. Script can use it, never read its bytes. |
| A record | One protected blob per line or file | A fresh random 12-byte IV for every record, kept in front of the ciphertext; the database, the object store and the record's key are the additional data, so a record moved to another place does not decrypt. |
| Where there is no OS key store | Owner-only files, not encrypted | In Node there is no IndexedDB: the SDK keeps sessions in memory, writes nothing and keeps no key. A host that keeps its own stores supplies a `SecretProtector` over its own key store. |
| A record that does not decrypt | Counted as unreadable in an export | Treated as absent and reported through `useStoreProblemHandler`; never thrown at the person. The report names the store and the kind, never contents. |
| A record of an earlier version | (never plain) | Earlier TypeScript versions wrote plain records. They are read once and written back encrypted, the first time the database is opened with a key. |

Only the keys of a record stay in the clear (the agent, the session id and the sequence number; the tool's name for an
approval): the text, the title, the times and a tool's class are inside the ciphertext. Where the page has no WebCrypto
(an insecure page) the stores keep plain records, as before.

```ts
// A host with its own key store (Node, or an extension with a native helper):
const protector: SecretProtector = {
  encrypts: true,
  protect: (data, context) => myKeyStore.seal(data, context),
  unprotect: (data, context) => myKeyStore.open(data, context), // throws when it is not this key's record
};
FadenstackAgent.createBuilder().useClient(client)
  .useSecretProtector(protector)
  .useStoreProblemHandler((problem) => console.warn(problem.store, problem.kind)); // no contents
```

A protector used for the stores is one the person's data depends on: data one protector wrote another cannot read.

## Export and delete my data

An access request (GDPR Art. 15 and 20) and an erasure request (Art. 17) for what this device holds. .NET:
`ExportMyDataAsync` and `DeleteMyDataAsync`.

```ts
const data = await agent.exportMyData();   // a MyDataExport: a JSON document, decrypted
const result = await agent.deleteMyData(); // a DataDeletion: { storesCleared, hostSessionStoreLeft, hostApprovalStoreLeft, hostStoresLeft }
```

Both start the agent first if it has not started, so the signed-in user is known. `MyDataExport`, `ExportedSession` and
`DataDeletion` are types of `@fadenstack/agents`.

`exportMyData()` returns one plain JSON object (the .NET SDK writes a ZIP; a document is what a page can hand to the
person as a download):

| Field | What it is |
|---|---|
| `format`, `version`, `exportedAt` | `"fadenstack-my-data"`, `1`, and when. |
| `sessions` | Every session of every agent the SDK's stores hold: `agent`, `id`, `started`, `lastActivity`, `title` and all `entries`, decrypted. |
| `approvals` | Per agent, the tools allowed always. |
| `counts` | `agents`, `sessions`, `approvals`, and `unreadable`: records that did not decrypt, which cannot be handed over. |
| `notIncluded` | What is not in it: sign-in tokens and secrets (never exported) and what the server keeps (ask its operator). |

A store you passed yourself is read for this agent only (it cannot name its agents).

`deleteMyData()` deletes the signed-in user's databases (sessions, "Allow always" and the preferences, such as the
level of thinking they picked) **and their key**, so that a copy of the profile restored later can never be read.
Afterwards the stores start empty, with a new key. It does not sign out (sign-in tokens stay; that is the host's call)
and it does not touch the server: what the server keeps is for its operator to erase. From a gateway that names no user it
clears the shared databases of an older SDK. The result:

| Field | What it is |
|---|---|
| `storesCleared` | How many of the SDK's IndexedDB databases existed and were removed (at most four: sessions, approvals, preferences, key). Stores in memory are simply dropped. The .NET SDK reports folders (`FoldersRemoved`). |
| `hostSessionStoreLeft`, `hostApprovalStoreLeft` | A store you passed with `useSessionStore` / `useApprovalStore` is **not** deleted: it may hold other people's data. The flag says it was left. |
| `hostStoresLeft` | Either of them: the person's data may still be in a store the host keeps. Delete their part there. |

Check `hostStoresLeft` before you tell the person their data is gone. When it is true, the SDK emptied its own
databases only, and the person's sessions or approvals may still be in the store you passed. A store of the host's own
reasoning pick (`useReasoningStore`) stays the host's as well.

It throws when a database stays open in a tab that does not close it; the SDK's own tabs close theirs on request.

### Retention

`IndexedDbSessionStore` keeps the newest 50 sessions of each agent, and none older than 90 days. Sessions beyond
these limits are deleted when a new session is created. To change the limits of the store the SDK keeps, use
`useSessionRetention`; to change the limits of a store you create yourself, pass your own:

```ts
import { FadenstackAgent, IndexedDbSessionStore } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder().useClient(client).useSessionRetention({ maxSessions: 20, maxAgeDays: 30 }).build();

const sessions = new IndexedDbSessionStore({ retention: { maxSessions: 20, maxAgeDays: 30 } });
const own = FadenstackAgent.createBuilder().useClient(client).useSessionStore(sessions).build();
```

**The server's limits.** A server may set `local_retention` in the agent's profile (`maxSessions`, `maxAgeDays`; only
positive whole numbers count). The SDK takes the stricter of the app's limits and the server's for each; a limit the
server leaves out stays the app's, and the server cannot raise a limit above the app's (`withinServerRetention`; .NET:
`SessionRetention.Within`). It applies to the store the SDK keeps, not to one you passed.

| Option | What it is |
|---|---|
| `name` | The database's name. Default `fadenstack-sessions`. |
| `retention` | `{ maxSessions, maxAgeDays }`, per agent. Default `DEFAULT_RETENTION`: 50 sessions, 90 days. |
| `indexedDB` | The IndexedDB factory. Default `globalThis.indexedDB`. |
| `keyRange` | The factory's `IDBKeyRange`. Default `globalThis.IDBKeyRange`. Pass it with `indexedDB`. |

`close()` closes the database; the next call opens it again.

`MemorySessionStore` has no limits: its sessions last as long as the page or process.

## Continue a session

```ts
const sessions = await agent.listSessions(); // newest first
const latest = sessions[0];
if (latest) {
  const session = await agent.openSession(latest.id);
  await session.send("And what about page 8?");
}
```

`listSessions()` returns `SessionInfo` items for the agent:

| Field | What it is |
|---|---|
| `id` | The session's id. |
| `agent` | The agent, by the slug or id you gave the builder. |
| `started` | When the session started, in ISO 8601. |
| `lastActivity` | When it was last used, in ISO 8601. |
| `title` | The first message, on one line and shortened to 60 characters. `null` before the first message. |

`openSession(id)` continues a session in the tool mode it was last in. Tools the user approved for the session still
run without asking. It throws when the store has no session with that id. `deleteSession(id)` deletes one.

An open session gives you its record:

| Property | What it is |
|---|---|
| `session.id` | The session's id. |
| `session.transcript` | The entries, as kept on the device. |
| `session.history` | The messages the next request would carry. |
| `session.approvedForSession` | The tools the user approved for the rest of the session. |

## What a request carries

Each request carries the session's history, built from the transcript on the device:

- a turn whose prompt was refused, a turn that failed (also one that was rate limited or over budget), and a turn
  that was stopped are left out entirely;
- of a turn whose answer the server stopped, only the question stays;
- when the history passes the budget (`useHistoryBudget`), the oldest turns are left out. The newest turn is always
  sent.

## The transcript

The transcript is a list of `TranscriptEntry` objects:

| Field | What it is |
|---|---|
| `id` | The entry's id. |
| `parentId` | The previous entry's id, or `null` for the first. |
| `timestamp` | When it was written, in ISO 8601. |
| `type` | One of the entry types below. |
| `turnId` | The turn it belongs to, or `null`. |
| `status` | For a turn's end: `ok`, `prompt_blocked`, `response_blocked`, `error` or `cancelled`. Otherwise `null`. |
| `data` | The entry's content, with snake_case keys. |

The entry types, as `EntryTypes` names them:

| Type | Entry |
|---|---|
| `session.start` | The session started: the agent, its version, the tool mode. |
| `user.message` | The user's message and its attachments. |
| `assistant.turn_start` | A turn started: the tool mode it runs in. |
| `assistant.message` | A model's answer: its text and tool calls. |
| `tool.execution_start` | A tool started. |
| `tool.execution_complete` | A tool ended: its result and outcome. |
| `approval.decision` | How a call that needed approval was decided: `approved`, what let it through (`scope`: `once`, `chat`, `always` or `grant`), whether the user was `asked`, whether an administrator's `rule` asked, `timed_out`, `wait_ms`. |
| `governance.notice` | A refusal or a limit. |
| `compaction` | The history was compacted. This SDK does not write such entries. |
| `assistant.turn_end` | The turn ended: its status, outcome and usage. |

The entry types and the `data` keys are the same as in the [.NET SDK](../dotnet/index.md).

## Your own store

To keep sessions somewhere else, for example in a project file of the host application, implement `SessionStore`:

```ts
import type { SessionInfo, TranscriptEntry } from "@fadenstack/agents";

interface SessionStore {
  append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void>;
  read(agent: string, sessionId: string): Promise<TranscriptEntry[]>;
  list(agent: string): Promise<SessionInfo[]>; // newest first
  delete(agent: string, sessionId: string): Promise<void>;
}
```

- `append` is called for each entry as it is written, and the agent waits for it. If it throws, the turn fails.
- `read` returns the entries in the order they were appended, or an empty list for a session it does not have.
- `list` returns the agent's sessions, newest activity first. `sessionInfo(agent, id, entries)` builds an item from
  the entries.
- `delete` removes the session.

This store keeps each session as a file of JSON lines, in a folder per agent:

```ts
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sessionInfo, type SessionInfo, type SessionStore, type TranscriptEntry } from "@fadenstack/agents";

export class FileSessionStore implements SessionStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
    await mkdir(join(this.#root, agent), { recursive: true });
    await appendFile(this.#file(agent, sessionId), `${JSON.stringify(entry)}\n`);
  }

  async read(agent: string, sessionId: string): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      text = await readFile(this.#file(agent, sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TranscriptEntry);
  }

  async list(agent: string): Promise<SessionInfo[]> {
    const names = await readdir(join(this.#root, agent)).catch(() => [] as string[]);
    const sessions: SessionInfo[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
      const id = name.slice(0, -".jsonl".length);
      const entries = await this.read(agent, id);
      if (entries.length > 0) sessions.push(sessionInfo(agent, id, entries));
    }
    return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  async delete(agent: string, sessionId: string): Promise<void> {
    await rm(this.#file(agent, sessionId), { force: true });
  }

  #file(agent: string, sessionId: string): string {
    return join(this.#root, agent, `${sessionId}.jsonl`);
  }
}
```

Retention is up to your store: with a store of your own, the SDK deletes a session only when you call
`deleteSession`.
