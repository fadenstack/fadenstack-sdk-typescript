# The record of tool calls

Every agent keeps a record of what its tools did in this browser: one entry for each tool call, with who or what let it run
or stopped it, and what became of it. The person has it for themselves, and for the defence file of the organisation that
runs the agent (EU product liability, the AI Act's logging duty). It is **content-free**: no prompt, no answer, no
argument and no result text, only names, classes, decisions and a hash of the arguments. It is hash-chained and sealed,
so a changed, deleted, swapped or forged entry is found. OWASP ASVS 5.0 V16 (security logging: integrity, protection,
retention). The .NET SDK keeps the same record on the device ([.NET: The record of tool calls](../dotnet/audit-log.md)).

It is on by default for every agent, governed and standalone, and every app and tab of the origin that signs the same
person in writes into the same log.

## What an entry holds

| Field | What it says |
|---|---|
| `seq` | The entry's number, from 1, without gaps. |
| `time` | When, UTC, ISO 8601 with milliseconds (`2026-11-16T09:30:00.123Z`). |
| `kind` | `tool` today; the field stays so later kinds (a stop, a switch turned off) fit. |
| `app` | The app's name as the per-app records use it (`describeApp`, else the agent's slug). |
| `agent`, `chat`, `turn` | The agent's slug, the chat's id and the turn's id. |
| `tool`, `class` | The tool's name (`(unknown)` for a name the model made up) and its class (`read`, `write`, `destructive`, `unknown`). |
| `source`, `server` | Where the tool comes from (`host`, `mcp`, `skills`, `web`, `gateway`) and the MCP server's label, as the approvals key them. |
| `decision` | Who or what let the call run, or stopped it (below). |
| `scope` | For how long an approval holds: `once`, `chat`, `always`, `time`; absent when none applies. |
| `outcome` | What became of the call (below). |
| `argumentsSha256` | SHA-256, lowercase hex, of the arguments' JSON text ([below](#the-hash-of-the-arguments)); `arguments_sha256` in the export and on the wire. |
| `prev`, `hash`, `seal` | The chain ([below](#the-chain)). |

**Decisions** (`AuditDecisions`):

| Decision | Meaning |
|---|---|
| `asked_approved`, `asked_denied`, `asked_timeout` | The person was asked and allowed it (the scope says for how long), declined, or did not answer in time. |
| `saved_approval` | An approval the person gave earlier stood: "Allow always" on this device (`always`), or "for this chat" (`chat`). |
| `mode` | Nobody was asked: the chat's tool mode lets this class of tool run. |
| `rule_allowed` | The server's rule for host tools said allow (the dispatch check answered `run`), and nobody was asked. |
| `rule_denied` | A rule refused it: the server's deny rule or the gateway's refusal, or the app's own hook. |
| `server_grant` | A grant the server holds (for a time, for a stretch of work, or the chat's Bypass) let it run, and nobody was asked. |
| `floor` | The approval floor says the question is never skipped, and the app has no way to ask it (no approval handler): the call did not run ([The never-skip list](approvals.md#the-never-skip-list)). |
| `hidden` | The chat's tool mode (read only) hides the tool: refused. |
| `none` | Nothing was decided: the tool does not exist, its arguments were not JSON, or the call stopped before a decision. |

**Outcomes** (`AuditOutcomes`): `ran`, `failed` (it ran and failed), `refused` (somebody or something said no), `cancelled`
(the turn was stopped while the call waited or ran) and `not_run` (it never ran and nobody refused it: an unknown tool,
arguments that were not JSON, a check that could not be made, a question nobody answered in time).

A call a gateway tool holds for the person (`faden.approval_required` with an approval id) is recorded when the person
answers, with source `gateway`: `ran` means it was released to the gateway, which runs it; the SDK sees no more of it.

## The hash of the arguments

`arguments_sha256` is the SHA-256 of the arguments' JSON text exactly as the tool call carried it (the model's
`function.arguments` string, `ToolCall.argumentsJson`), UTF-8, lowercase hex; a blank text is `{}`, as the SDK writes it back.
The server stores the SDK's value and never computes it itself, so both SDKs must agree, and they do (a shared test vector is
in both suites). For a person's own command (`invokeTool`) the text is the canonical command JSON the server's check also
sees. For a call a gateway holds, the gateway keeps the arguments: the hash is there only if its word carries them as a text
(`arguments`), else the entry has none.

## The chain

`hash` is the SHA-256 (lowercase hex) of a canonical text: `fadenstack.audit.v1`, then `seq`, `time`, `kind`, `app`,
`agent`, `chat`, `turn`, `tool`, `class`, `source`, `server`, `decision`, `scope`, `outcome`, `arguments_sha256` and `prev`,
joined by a line feed, an absent value as the empty string. It is never a JSON serialization, so both SDKs agree byte for
byte (`auditCanonicalText`). `prev` is the previous entry's `hash`, 64 zeros for entry 1. `seal` is the base64
HMAC-SHA256 of `hash` under a key of this log's own, made at the first write. WebCrypto does the hashing and the HMAC.

## Where it is kept

`IndexedDbAuditLog` keeps it in the person's own database, `fadenstack-audit:<tenant>:<user>` ([Data on the device](data-on-device.md)):

| Store | What it holds |
|---|---|
| `entries` | One row per entry, keyed by `seq`. The row is the entry's JSON sealed with the agent's `SecretProtector` (the person's AES-GCM key), bound to its database, store and number, so a row moved elsewhere does not open. |
| `meta` | The seal key (32 random bytes, sealed with the protector) and the anchor a prune leaves. |

**Several tabs and apps.** An entry is added under its `seq` with IndexedDB's `add`, which refuses a key that exists. A writer
that lost the race reads the new last entry and tries again, so tabs and apps of one origin never fork the chain (two
instances appending in parallel are tested). The key is made the same way: added, never replaced. (A transaction cannot stay
open across WebCrypto's asynchronous hashing, so the lock is the key's uniqueness rather than one long transaction.)

**Writing never breaks a turn.** An append that fails is logged (the kind of failure only, event 2083), the tool call goes
on, and the next verify reports the gap. Where there is no IndexedDB (Node), or the host keeps both its own stores, the
record lives in memory for the run (`MemoryAuditLog`).

## Keeping and removing it

Entries older than the retention go when the agent starts and then at most once a day: 180 days by default, or the machine
policy's `auditRetentionDays` (30 to 3650; [Machine policy](machine-policy.md)). The last removed entry's `seq` and `hash`
stay in the sealed anchor, and the anchor and the removal are one transaction, so what is left still verifies.
`agent.auditRetentionDays` says the number in force.

## Checking and exporting it

```ts
const result = await agent.verifyAudit();
// { intact, entries, firstSeq?, firstTime?, lastTime?, brokenAtSeq?, problem? }

const html = await agent.exportAudit("html"); // or "csv": text, for the app to save or offer as a download
```

`verify` checks that every row decrypts and parses, that `seq` has no gap, that every `prev` links, that every hash
recomputes, that every seal holds, and that the first entry links to the anchor (or to zeros at entry 1). A problem names
its kind (`AuditProblems`: `unreadable_line`, `seq_gap`, `prev_mismatch`, `hash_mismatch`, `seal_mismatch`, `anchor_mismatch`,
`anchor_missing`, `key_missing`) and the entry's number, never content.

`export` writes every entry readable, with the verification result at the top. The CSV has the verification in its first
two lines, then one row per entry; a cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet
never reads it as a formula. The HTML is one self-contained page: a table, escaped text, inline CSS, no script and no
outside resource. Both are in English: they are a record, not a screen.

## In your app

```ts
const agent = FadenstackAgent.createBuilder()
  /* ... */
  .useAuditLog(new MemoryAuditLog()) // tests, or the app's own place; by default an IndexedDbAuditLog per person
  .build();
```

- **By default** an agent keeps the record in the person's database. An agent whose app passes **both** its own session store
  and its own approval store has taken over the browser storage: its record then stays in memory for the run unless the app
  passes its own log (the same rule as the thinking level).
- `useAuditLog(log)` replaces the log. `AuditLog` has `append`, `verify`, `export` and `prune`; `MemoryAuditLog` and
  `IndexedDbAuditLog` implement it.
- The agent appends in one place: where it settles and finishes a tool call (the session's `#runTool`), not in every tool.

## What the server is told

`approval.decided` and `tool.executed` carry `arguments_sha256`, and so does the answer to a call the server holds
(`POST /v1/agents/{agent}/approvals/{id}`; `answerApproval(id, approved, scope, argumentsSha256)`), **only when the profile's
`features` list `client_events.arguments_sha256`**. An older server refuses a whole batch with an unknown field (400
`invalid_events`), so without the feature nothing new is sent. `@fadenstack/testing`'s `FakeGateway` teaches the field and the
feature (list it in `features`; without it the fake refuses the field as core does). The server can pair its own record of a
call with the device's by this hash without ever holding the arguments' text.

## What the person sees

"Your data in this browser" ([Data on the device](data-on-device.md#export-and-delete)) has a line and a button for it:
"Record of tool calls: 12 entries since 01/08/2026, intact" (or "damaged at entry 8", "no entries yet", "could not be
checked"), and "Export the record of tool calls…", which raises `onSaveRequest` with the record as a web page
(`kind: "audit"`, `text/html`). The export of the person's data holds the record as `auditLog` (the CSV with its
verification on top, and the verification). The record is shared data, like the provenance records: "Remove my data…" leaves
it while another Fadenstack app uses the person's data in the browser, and "Remove all my Fadenstack data in this browser…" or
the last app takes it. The texts are in the five languages the package ships.

## What it does not do

It is tamper-evident, not tamper-proof. Script on the page can use the person's key, so someone who runs code in the origin
can write a chain that verifies. Taking away the **last** entries leaves a chain that still verifies, because nothing after
them names them: pair the record with the server's own count where the server keeps one. What it does find is what the person
or a defence file needs: a changed field, a deleted or swapped entry, an entry from another person's log, a seal that does not
hold, and a log that was cut at the front without its anchor.
