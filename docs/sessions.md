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

What this protects, and what it does not:

- IndexedDB belongs to one origin. Other websites and other extensions cannot read the sessions.
- The sessions are not encrypted beyond what the browser does for its profile. Anyone who can read the browser profile
  on disk can read them, and so can any script that runs in your origin. For a web page, that includes every page of
  the same site.
- A browser has no per-user secret store for the SDK to use, unlike the .NET SDK, which protects sessions with DPAPI on
  Windows.
- Clearing the site's data in the browser, or removing the extension, deletes the sessions.

### Retention

`IndexedDbSessionStore` keeps the newest 50 sessions of each agent, and none older than 90 days. Sessions beyond
these limits are deleted when a new session is created. To change the limits, pass your own:

```ts
import { FadenAgent, IndexedDbSessionStore } from "@fadenstack/agents";

const sessions = new IndexedDbSessionStore({ retention: { maxSessions: 20, maxAgeDays: 30 } });
const agent = FadenAgent.createBuilder().useClient(client).useSessionStore(sessions).build();
```

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
| `approval.decision` | The user's decision on a tool call. |
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
