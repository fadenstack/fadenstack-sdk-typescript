import { recordContext, type SecretProtector } from "./secretProtection.js";
import { WorkQueue, openJson, request, sealJson, transact } from "./storeSupport.js";

/** What an audit entry is about. Only `tool` exists today; the field stays so later kinds fit. .NET: `AuditKinds`. */
export const AuditKinds = Object.freeze({ tool: "tool" });

/**
 * Who or what let a tool call run, or stopped it (`AuditRecord.decision`). The SDK writes exactly these; a later version may add
 * more, so a reader treats an unknown one as "other". .NET: `AuditDecisions`.
 */
export const AuditDecisions = Object.freeze({
  /** The person was asked and allowed it (the scope says for how long). */
  askedApproved: "asked_approved",
  /** The person was asked and declined. */
  askedDenied: "asked_denied",
  /** The person was asked and did not answer in time: the call did not run. */
  askedTimeout: "asked_timeout",
  /** An approval the person gave earlier stood: "Allow always" on this device, or "for this chat". */
  savedApproval: "saved_approval",
  /** Nobody was asked: the chat's tool mode lets this class of tool run. */
  mode: "mode",
  /** The server's rule for host tools said allow, and nobody was asked. */
  ruleAllowed: "rule_allowed",
  /** A rule refused it: the server's deny rule, or the app's own hook. */
  ruleDenied: "rule_denied",
  /** A grant the server holds (a time grant, a stretch of work, or the chat's Bypass) let it run, and nobody was asked. */
  serverGrant: "server_grant",
  /** The approval floor says the question is never skipped, and the app has no way to ask it (no approval handler): the call did not run. */
  floor: "floor",
  /** The chat's tool mode (ReadOnly) hides this tool: the call was refused. */
  hidden: "hidden",
  /** Nothing was decided: the tool does not exist, its arguments were not JSON, or the call stopped before a decision. */
  none: "none",
});

/** What became of a tool call (`AuditRecord.outcome`). .NET: `AuditOutcomes`. */
export const AuditOutcomes = Object.freeze({
  /** The tool ran and returned. For a gateway tool the server runs, the call was released to it. */
  ran: "ran",
  /** The tool ran and failed. */
  failed: "failed",
  /** Somebody or something refused it (the person, a rule, the mode). */
  refused: "refused",
  /** The turn was stopped while the call waited or ran. */
  cancelled: "cancelled",
  /** It never ran and nobody refused it (unknown tool, arguments that were not JSON, a check that could not be made). */
  notRun: "not_run",
});

/** For how long an approval holds (`AuditRecord.scope`). .NET: `AuditScopes`. */
export const AuditScopes = Object.freeze({ once: "once", chat: "chat", always: "always", time: "time" });

/** The kinds of problem `AuditVerification.problem` names. .NET: `AuditProblems`. */
export const AuditProblems = Object.freeze({
  /** A line cannot be decrypted or parsed (damaged, or another person's). */
  unreadable: "unreadable_line",
  /** A seq is missing, repeated or out of order (a deleted or swapped entry). */
  seqGap: "seq_gap",
  /** An entry's `prev` is not the previous entry's hash. */
  prevMismatch: "prev_mismatch",
  /** An entry's hash is not what its fields give (a changed field). */
  hashMismatch: "hash_mismatch",
  /** An entry's seal does not hold under this log's key (forged, or from another log). */
  sealMismatch: "seal_mismatch",
  /** The anchor left by a prune does not hold, or does not match the first entry. */
  anchorMismatch: "anchor_mismatch",
  /** The log starts after seq 1 and no anchor says why. */
  anchorMissing: "anchor_missing",
  /** The log has entries and the seal key is gone: no seal can be checked. */
  keyMissing: "key_missing",
  /** The last entry is not the one the sealed head names: entries after the head's number are missing (the tail was cut), or the head names another hash, or was forged. */
  headMismatch: "head_mismatch",
  /** The log has entries and no head: the head was deleted (or the log is from before the head existed and has not been written to since). */
  headMissing: "head_missing",
});

/** How long entries are kept: 180 days unless the machine policy's `auditRetentionDays` says otherwise (30 to 3650). .NET: `AuditRetention`. */
export const AuditRetention = Object.freeze({
  defaultDays: 180,
  minDays: 30,
  maxDays: 3650,
  isValid: (days: number): boolean => Number.isInteger(days) && days >= 30 && days <= 3650,
});

/** The profile's feature that lets the SDK send `arguments_sha256` in its events and answers (an older server refuses the batch). */
export const ARGUMENTS_SHA256_FEATURE = "client_events.arguments_sha256";

/**
 * One tool call decision and outcome, as an app hands it to `AuditLog.append`: content-free (no prompt, answer, argument or result
 * text). The log adds `seq`, `prev`, `hash` and `seal`. .NET: `AuditRecord`.
 */
export interface AuditRecord {
  /** ISO 8601 UTC, to the millisecond; absent: now. */
  time?: string;
  /** `AuditKinds`; `tool` by default. */
  kind?: string;
  /** The app's name, as the per-app records use it (`appName`). */
  app: string;
  /** The agent's slug. */
  agent: string;
  /** The chat's (session's) id. */
  chat: string;
  /** The turn's id. */
  turn: string;
  /** The tool's name; `(unknown)` for a name the model made up. */
  tool: string;
  /** The tool's class by its wire name (`read`, `write`, `destructive`, `unknown`). */
  class: string;
  /** Where the tool comes from (`host`, `mcp`, `skills`, `web`, `gateway`, ...), as the approvals key it. */
  source?: string;
  /** The MCP server's label, for an MCP tool. */
  server?: string;
  /** `AuditDecisions`. */
  decision: string;
  /** `AuditScopes`, or absent. */
  scope?: string;
  /** `AuditOutcomes`. */
  outcome: string;
  /** SHA-256, lowercase hex, of the call's arguments JSON text (`argumentsSha256`); absent when the SDK never had the text. */
  argumentsSha256?: string;
}

/** An entry of the log: the record, its place in the chain, its hash and its seal. .NET: `AuditEntry`. */
export interface AuditEntry {
  seq: number;
  /** ISO 8601 UTC to the millisecond (`2026-11-16T09:30:00.123Z`). */
  time: string;
  kind: string;
  app: string;
  agent: string;
  chat: string;
  turn: string;
  tool: string;
  class: string;
  source?: string;
  server?: string;
  decision: string;
  scope?: string;
  outcome: string;
  argumentsSha256?: string;
  /** The previous entry's `hash`; 64 zeros for seq 1. */
  prev: string;
  /** SHA-256, lowercase hex, of the canonical text (`auditCanonicalText`). */
  hash: string;
  /** Base64 HMAC-SHA256 of `hash` under the log's own key. */
  seal: string;
}

/**
 * What `AuditLog.verify` found. A problem names its kind and the entry's seq, never content. .NET: `AuditVerification`.
 */
export interface AuditVerification {
  /** Every line reads, `seq` has no gap, every `prev` links, every hash and seal holds, and the first entry links to the anchor (or to zeros at seq 1). */
  intact: boolean;
  entries: number;
  firstSeq?: number;
  firstTime?: string;
  lastTime?: string;
  /** Where the chain breaks: the seq of the entry that does not hold (for a line that cannot be read or a gap, the seq that was expected). */
  brokenAtSeq?: number;
  /** One of `AuditProblems`. */
  problem?: string;
}

/** The format of `AuditLog.export`. .NET: `AuditExportFormat`. */
export type AuditExportFormat = "csv" | "html";

/**
 * The person's own tamper-evident record of what the agent's tools did in this browser (sdk/51 8.10): one entry per tool call
 * decision and outcome, content-free, every app of the person writing into the same log. Hash-chained and sealed, so a changed,
 * deleted, swapped or forged entry is found by `verify`. OWASP ASVS 5.0 V16 (security logging: integrity, protection, retention).
 * .NET: `IAuditLog`.
 */
export interface AuditLog {
  /** Adds an entry after the last one. Never forks the chain, whatever other tabs and apps of the origin write at the same time. */
  append(record: AuditRecord): Promise<AuditEntry>;
  /** Checks the whole chain. */
  verify(): Promise<AuditVerification>;
  /**
   * Every entry readable, with the verification result at the top: a CSV, or one self-contained HTML page (a table, escaped text,
   * inline CSS, no script, no outside resource), as text.
   */
  export(format: AuditExportFormat): Promise<string>;
  /**
   * Removes the entries older than `retentionDays` days from the start of the log and says how many went. The last removed entry's
   * seq and hash stay in the sealed anchor, so what is left still verifies.
   */
  prune(retentionDays: number): Promise<number>;
}

/** The sealed head: the last entry's number and hash, written with every append, so that cutting off the end of the log is found. .NET: `audit-head.json`. */
export interface AuditHead {
  seq: number;
  hash: string;
  seal: string;
}

/** The sealed mark a prune leaves: the last removed entry's seq and hash. */
export interface AuditAnchor {
  seq: number;
  hash: string;
  prunedAt: string;
  seal: string;
}

// ---- the chain: the same bytes as .NET's `AuditChain` (shared test vectors in both suites) ----

const encoder = new TextEncoder();

/** The first line of the canonical text. */
export const AUDIT_VERSION = "fadenstack.audit.v1";
const ANCHOR_VERSION = "fadenstack.audit.anchor.v1";
const HEAD_VERSION = "fadenstack.audit.head.v1";

/** The `prev` of seq 1: 64 zeros. */
export const AUDIT_ZEROS = "0".repeat(64);

/**
 * The canonical text of an entry: the version, then seq, time, kind, app, agent, chat, turn, tool, class, source, server, decision,
 * scope, outcome, arguments_sha256 and prev, joined by a line feed; absent is the empty string. Never a JSON serialization, so both
 * SDKs agree byte for byte. .NET: `AuditChain.CanonicalText`.
 */
export function auditCanonicalText(e: Omit<AuditEntry, "hash" | "seal">): string {
  return [AUDIT_VERSION, String(e.seq), e.time, e.kind, e.app, e.agent, e.chat, e.turn, e.tool, e.class, e.source ?? "", e.server ?? "",
    e.decision, e.scope ?? "", e.outcome, e.argumentsSha256 ?? "", e.prev].join("\n");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: ArrayBuffer | Uint8Array): string {
  let text = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** SHA-256 of a text's UTF-8 bytes, lowercase hex (WebCrypto). */
async function sha256Hex(text: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text) as BufferSource));
}

/** The entry's hash: SHA-256 of `auditCanonicalText` (UTF-8), lowercase hex. .NET: `AuditChain.HashOf`. */
export function auditHash(e: Omit<AuditEntry, "hash" | "seal">): Promise<string> {
  return sha256Hex(auditCanonicalText(e));
}

async function hmac(key: Uint8Array, text: string): Promise<string> {
  const imported = await globalThis.crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64(await globalThis.crypto.subtle.sign("HMAC", imported, encoder.encode(text) as BufferSource));
}

/** The seal of a hash: base64 of HMAC-SHA256 under `key`, over the hash text (ASCII). .NET: `AuditChain.SealOf`. */
export function auditSeal(key: Uint8Array, hash: string): Promise<string> {
  return hmac(key, hash);
}

/** The anchor's seal: HMAC-SHA256 over the anchor version, the seq and the hash. .NET: `AuditChain.AnchorSeal`. */
export function auditAnchorSeal(key: Uint8Array, seq: number, hash: string): Promise<string> {
  return hmac(key, `${ANCHOR_VERSION}\n${seq}\n${hash}`);
}

/** The head's seal: the same shape as the anchor's, under the head version. .NET: `AuditChain.HeadSeal`. */
export function auditHeadSeal(key: Uint8Array, seq: number, hash: string): Promise<string> {
  return hmac(key, `${HEAD_VERSION}\n${seq}\n${hash}`);
}

/**
 * The arguments hash: SHA-256 of the arguments' JSON text, UTF-8, lowercase hex. The text is the model's `function.arguments` string
 * exactly as the stream carried it (blank: `{}`, as the SDK writes it back). .NET: `AuditChain.ArgumentsSha256`.
 */
export function argumentsSha256(argumentsJson: string): Promise<string> {
  return sha256Hex(argumentsJson);
}

/** A time as the chain writes it: UTC, ISO 8601, to the millisecond. */
export function auditIso(time: Date | number | string): string {
  return new Date(time).toISOString();
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Compares two texts without stopping at the first difference. */
function fixedEquals(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Makes the entry after `prev` (the seq and hash of the one before; none: the first). .NET: `AuditChain.Next`. */
export async function nextAuditEntry(record: AuditRecord, prev: { seq: number; hash: string } | undefined, key: Uint8Array, now: Date): Promise<AuditEntry> {
  const entry: Omit<AuditEntry, "hash" | "seal"> = {
    seq: (prev?.seq ?? 0) + 1,
    time: auditIso(record.time ?? now),
    kind: record.kind ?? AuditKinds.tool,
    app: record.app, agent: record.agent, chat: record.chat, turn: record.turn, tool: record.tool, class: record.class,
    ...(record.source ? { source: record.source } : {}),
    ...(record.server ? { server: record.server } : {}),
    decision: record.decision,
    ...(record.scope ? { scope: record.scope } : {}),
    outcome: record.outcome,
    ...(record.argumentsSha256 ? { argumentsSha256: record.argumentsSha256 } : {}),
    prev: prev?.hash ?? AUDIT_ZEROS,
  };
  const hash = await auditHash(entry);
  return { ...entry, hash, seal: await auditSeal(key, hash) };
}

/** The entry as a line keeps it (snake_case keys, as .NET writes them; nulls kept). */
export function auditToWire(e: AuditEntry): Record<string, unknown> {
  return { seq: e.seq, time: e.time, kind: e.kind, app: e.app, agent: e.agent, chat: e.chat, turn: e.turn, tool: e.tool, class: e.class,
    source: e.source ?? null, server: e.server ?? null, decision: e.decision, scope: e.scope ?? null, outcome: e.outcome,
    arguments_sha256: e.argumentsSha256 ?? null, prev: e.prev, hash: e.hash, seal: e.seal };
}

/** Reads a line's JSON; undefined when it is not an entry of the format (a missing or mistyped field, a time of another shape). */
export function auditFromWire(value: unknown): AuditEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const required = (name: string): string | undefined => (typeof o[name] === "string" ? (o[name] as string) : undefined);
  const optional = (name: string): string | undefined | null => (o[name] === null || o[name] === undefined ? undefined : typeof o[name] === "string" ? (o[name] as string) : null);
  const seq = o["seq"];
  const [time, kind, app, agent, chat, turn, tool, cls, decision, outcome, prev, hash, seal] =
    ["time", "kind", "app", "agent", "chat", "turn", "tool", "class", "decision", "outcome", "prev", "hash", "seal"].map(required);
  const source = optional("source"), server = optional("server"), scope = optional("scope"), args = optional("arguments_sha256");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || [time, kind, app, agent, chat, turn, tool, cls, decision, outcome, prev, hash, seal].some((v) => v === undefined)
    || [source, server, scope, args].some((v) => v === null) || !ISO_TIME.test(time!)) return undefined;
  return { seq, time: time!, kind: kind!, app: app!, agent: agent!, chat: chat!, turn: turn!, tool: tool!, class: cls!,
    ...(source ? { source } : {}), ...(server ? { server } : {}), decision: decision!, ...(scope ? { scope } : {}), outcome: outcome!,
    ...(args ? { argumentsSha256: args } : {}), prev: prev!, hash: hash!, seal: seal! };
}

/**
 * Checks entries in order (`undefined`: a line that could not be read). `key` undefined: no seal can be checked. The first entry links
 * to `anchor` when the log starts after seq 1. .NET: `AuditChain.Verify`.
 */
export async function verifyAuditChain(entries: readonly (AuditEntry | undefined)[], key: Uint8Array | undefined, anchor: AuditAnchor | undefined, head?: AuditHead): Promise<AuditVerification> {
  let count = 0;
  let first: AuditEntry | undefined;
  let last: AuditEntry | undefined;
  const broken = (seq: number, problem: string): AuditVerification => ({
    intact: false, entries: count, ...(first ? { firstSeq: first.seq, firstTime: first.time } : {}), ...(last ? { lastTime: last.time } : {}),
    brokenAtSeq: seq, problem,
  });
  if (anchor && (!key || !fixedEquals(anchor.seal, await auditAnchorSeal(key, anchor.seq, anchor.hash)))) return broken(anchor.seq, AuditProblems.anchorMismatch);
  for (const entry of entries) {
    if (!entry) return broken((last?.seq ?? anchor?.seq ?? 0) + 1, AuditProblems.unreadable);
    let expectedSeq: number;
    let expectedPrev: string;
    if (last) [expectedSeq, expectedPrev] = [last.seq + 1, last.hash];
    else if (entry.seq === 1) [expectedSeq, expectedPrev] = [1, AUDIT_ZEROS];
    else if (!anchor) return broken(entry.seq, AuditProblems.anchorMissing);
    else [expectedSeq, expectedPrev] = [anchor.seq + 1, anchor.hash];
    if (entry.seq !== expectedSeq) return broken(expectedSeq, AuditProblems.seqGap);
    if (!fixedEquals(entry.prev, expectedPrev)) return broken(entry.seq, AuditProblems.prevMismatch);
    if (!fixedEquals(entry.hash, await auditHash(entry))) return broken(entry.seq, AuditProblems.hashMismatch);
    if (!key) return broken(entry.seq, AuditProblems.keyMissing);
    if (!fixedEquals(entry.seal, await auditSeal(key, entry.hash))) return broken(entry.seq, AuditProblems.sealMismatch);
    if (anchor && entry.seq === anchor.seq && !fixedEquals(entry.hash, anchor.hash)) return broken(entry.seq, AuditProblems.anchorMismatch); // a prune that did not finish
    first ??= entry;
    last = entry;
    count++;
  }
  // The sealed head: the log must end where it says. Entries gone from the end, a head that names another entry, a forged head or a deleted one are found.
  if (last || anchor || head) {
    const endSeq = last?.seq ?? anchor?.seq ?? 0;
    const endHash = last?.hash ?? anchor?.hash ?? "";
    if (!head) return broken(endSeq, AuditProblems.headMissing);
    if (!key || !fixedEquals(head.seal, await auditHeadSeal(key, head.seq, head.hash))) return broken(head.seq, AuditProblems.headMismatch);
    if (head.seq !== endSeq || !fixedEquals(head.hash, endHash)) return broken(head.seq > endSeq ? endSeq + 1 : head.seq, AuditProblems.headMismatch);
  }
  return { intact: true, entries: count, ...(first ? { firstSeq: first.seq, firstTime: first.time } : {}), ...(last ? { lastTime: last.time } : {}) };
}

// ---- export: the verification first, content-free like the log ----

const COLUMNS = ["seq", "time", "kind", "app", "agent", "chat", "turn", "tool", "class", "source", "server", "decision", "scope", "outcome",
  "arguments_sha256", "prev", "hash", "seal"] as const;

function cells(e: AuditEntry): string[] {
  return [String(e.seq), e.time, e.kind, e.app, e.agent, e.chat, e.turn, e.tool, e.class, e.source ?? "", e.server ?? "", e.decision, e.scope ?? "",
    e.outcome, e.argumentsSha256 ?? "", e.prev, e.hash, e.seal];
}

/**
 * A CSV cell: quoted when it needs it (a `,`, `;`, quote, CR or LF), and never read as a formula by a spreadsheet: a
 * `'` goes before a `= + - @`, tab, CR or NUL at the start of the field and right after a `;` or `,` inside it.
 * .NET: `AuditExport.Cell`; the table download of `@fadenstack/ui` (`csvField`) follows the same rule.
 */
export function csvCell(value: string): string {
  value = value.replace(/(^|[;,])(?=[=+\-@\t\r\0])/g, "$1'");
  return /[;,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function row(values: readonly string[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

function htmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** The export as text: a CSV (the verification as the first two lines, a blank line, the column names, then the rows) or one HTML page. .NET: `AuditExport`. */
export function auditExportText(format: AuditExportFormat, v: AuditVerification, entries: readonly AuditEntry[]): string {
  if (format === "html") return auditHtml(v, entries);
  return row(["verification", "intact", "entries", "first_seq", "first_time", "last_time", "broken_at_seq", "problem"])
    + row(["verification", String(v.intact), String(v.entries), v.firstSeq === undefined ? "" : String(v.firstSeq), v.firstTime ?? "", v.lastTime ?? "",
      v.brokenAtSeq === undefined ? "" : String(v.brokenAtSeq), v.problem ?? ""])
    + "\r\n" + row(COLUMNS) + entries.map((e) => row(cells(e))).join("");
}

function auditHtml(v: AuditVerification, entries: readonly AuditEntry[]): string {
  const e = htmlEscape;
  const lines = ["<!DOCTYPE html>", '<html lang="en">', "<head>", '<meta charset="utf-8">', "<title>Record of tool calls</title>", "<style>",
    "body{font-family:system-ui,sans-serif;margin:24px;color:#1b1b1b;background:#fff}",
    "table{border-collapse:collapse;font-size:12px}", "th,td{border:1px solid #b0b0b0;padding:3px 6px;text-align:left;vertical-align:top}",
    "th{background:#eee}", ".hash{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}",
    ".ok{color:#0b6b2a;font-weight:600}.bad{color:#a00000;font-weight:600}",
    "@media (prefers-color-scheme:dark){body{background:#161616;color:#e8e8e8}th{background:#2a2a2a}th,td{border-color:#555}.ok{color:#6fd68c}.bad{color:#ff8a8a}}",
    "</style>", "</head>", "<body>", "<h1>Record of tool calls</h1>"];
  let summary = `<p>${v.intact ? '<span class="ok">Intact</span>' : '<span class="bad">Damaged</span>'}: ${v.entries} entries`;
  if (v.firstTime && v.lastTime) summary += `, from ${e(v.firstTime)} to ${e(v.lastTime)}`;
  if (!v.intact) summary += `. Problem: ${e(v.problem ?? "")} at entry ${v.brokenAtSeq ?? ""}`;
  lines.push(`${summary}.</p>`, "<table>", `<thead><tr>${COLUMNS.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead>`, "<tbody>");
  for (const entry of entries) lines.push(`<tr>${cells(entry).map((c, i) => `<td${i >= 14 ? ' class="hash"' : ""}>${e(c)}</td>`).join("")}</tr>`);
  lines.push("</tbody>", "</table>", "</body>", "</html>", "");
  return lines.join("\n");
}

// ---- the logs ----

function randomKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The log kept in memory only: gone with the page or process (tests, a host that keeps nothing). Same chain, same checks. .NET: `MemoryAuditLog`. */
export class MemoryAuditLog implements AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #key = randomKey();
  readonly #clock: () => Date;
  readonly #queue = new WorkQueue();
  #anchor: AuditAnchor | undefined;
  #head: AuditHead | undefined;

  /** @param clock The time of an entry that names none; now by default. */
  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  /** The entries now, for a test. */
  get entries(): readonly AuditEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  append(record: AuditRecord): Promise<AuditEntry> {
    return this.#queue.run(async () => {
      const last = this.#entries.at(-1);
      const prev = last ?? this.#anchor;
      const entry = await nextAuditEntry(record, prev ? { seq: prev.seq, hash: prev.hash } : undefined, this.#key, this.#clock());
      this.#entries.push(entry);
      this.#head = { seq: entry.seq, hash: entry.hash, seal: await auditHeadSeal(this.#key, entry.seq, entry.hash) };
      return { ...entry };
    });
  }

  verify(): Promise<AuditVerification> {
    return this.#queue.run(() => verifyAuditChain(this.#entries, this.#key, this.#anchor, this.#head));
  }

  export(format: AuditExportFormat): Promise<string> {
    return this.#queue.run(async () => auditExportText(format, await verifyAuditChain(this.#entries, this.#key, this.#anchor, this.#head), this.#entries));
  }

  prune(retentionDays: number): Promise<number> {
    return this.#queue.run(async () => {
      const cutoff = this.#clock().getTime() - retentionDays * 86_400_000;
      let gone = 0;
      while (gone < this.#entries.length && Date.parse(this.#entries[gone]!.time) < cutoff) gone++;
      if (gone > 0) {
        const lastGone = this.#entries[gone - 1]!;
        this.#anchor = { seq: lastGone.seq, hash: lastGone.hash, prunedAt: auditIso(this.#clock()), seal: await auditAnchorSeal(this.#key, lastGone.seq, lastGone.hash) };
        this.#entries.splice(0, gone);
      }
      return gone;
    });
  }
}

const ENTRIES = "entries";
const META = "meta";
const SEAL_KEY = "seal";
const ANCHOR = "anchor";
const HEAD = "head";

interface Row {
  seq: number;
  /** The entry's JSON, sealed with the agent's protector (absent where nothing seals). */
  data?: Uint8Array;
  /** The entry, plain: only where there is no protector. */
  entry?: Record<string, unknown>;
}

export interface IndexedDbAuditLogOptions {
  /** The database's name (`fadenstack-audit:<tenant>:<user>`, one per signed-in person). */
  name: string;
  /** What seals the lines and the key (the agent's `SecretProtector`); without one they are kept plain. */
  protector?: SecretProtector | undefined;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
  /** The time of an entry that names none; now by default. */
  clock?: () => Date;
}

/**
 * The log in the person's own IndexedDB database (`fadenstack-audit:<tenant>:<user>`): an `entries` store keyed by `seq`, and a `meta`
 * store with the sealed key and the anchor. Every tab and app of this origin that signs the same person in writes to the same log.
 * An entry is added under its seq with `add`, which IndexedDB refuses when the key exists: a writer that lost the race reads the new
 * last entry and tries again, so tabs and apps never fork the chain. The key is made the same way (added, never replaced).
 * .NET: `FileAuditLog`.
 */
export class IndexedDbAuditLog implements AuditLog {
  readonly #name: string;
  readonly #factory: IDBFactory;
  readonly #protector: SecretProtector | undefined;
  readonly #clock: () => Date;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbAuditLogOptions) {
    this.#name = options.name;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryAuditLog.");
    this.#factory = factory;
    this.#protector = options.protector;
    this.#clock = options.clock ?? (() => new Date());
  }

  async append(record: AuditRecord): Promise<AuditEntry> {
    const key = await this.#key(true);
    if (!key) throw new Error("The audit log's seal key cannot be read.");
    for (let attempt = 0; attempt < 50; attempt++) {
      const last = await this.#lastKnown();
      const entry = await nextAuditEntry(record, last, key, this.#clock());
      const row = await this.#row(entry);
      const head: AuditHead = { seq: entry.seq, hash: entry.hash, seal: await auditHeadSeal(key, entry.seq, entry.hash) };
      try {
        // The entry and the head in one transaction: the add's ConstraintError aborts both, so the loser of a race leaves no head behind. A log from
        // before the head existed takes its head with its next append.
        await this.#write("readwrite", [ENTRIES, META], (tx) => { tx.objectStore(ENTRIES).add(row); tx.objectStore(META).put(head, HEAD); });
        return entry;
      } catch (error) {
        if ((error as { name?: string } | undefined)?.name !== "ConstraintError") throw error; // another writer took the seq: read again
      }
    }
    throw new Error("The audit log is busy.");
  }

  async verify(): Promise<AuditVerification> {
    const { entries, key, anchor, head } = await this.#all();
    return verifyAuditChain(entries, key, anchor, head);
  }

  async export(format: AuditExportFormat): Promise<string> {
    const { entries, key, anchor, head } = await this.#all();
    return auditExportText(format, await verifyAuditChain(entries, key, anchor, head), entries.filter((e): e is AuditEntry => e !== undefined));
  }

  async prune(retentionDays: number): Promise<number> {
    const { entries, key } = await this.#all();
    if (!key) return 0;
    const cutoff = this.#clock().getTime() - retentionDays * 86_400_000;
    let gone = 0;
    for (const entry of entries) {
      if (!entry || Date.parse(entry.time) >= cutoff) break; // a damaged line is kept for verify to name; so is everything after the first entry that is not old
      gone++;
    }
    if (gone === 0) return 0;
    const lastGone = entries[gone - 1]!;
    const anchor: AuditAnchor = { seq: lastGone.seq, hash: lastGone.hash, prunedAt: auditIso(this.#clock()), seal: await auditAnchorSeal(key, lastGone.seq, lastGone.hash) };
    // The anchor and the removal in one transaction: a prune is whole or not at all.
    await this.#write("readwrite", [ENTRIES, META], (tx) => {
      tx.objectStore(META).put(anchor, ANCHOR);
      tx.objectStore(ENTRIES).delete(IDBKeyRange.upperBound(lastGone.seq));
    });
    return gone;
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close(), () => undefined);
    this.#db = undefined;
  }

  /** Closes the database and waits until it is closed, so that it can be deleted. */
  async closeAsync(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    if (db) (await db.catch(() => undefined))?.close();
  }

  // ---- rows ----

  #context(seq: number): string {
    return recordContext(this.#name, ENTRIES, "entries", String(seq));
  }

  async #row(entry: AuditEntry): Promise<Row> {
    const wire = auditToWire(entry);
    return this.#protector ? { seq: entry.seq, data: await sealJson(this.#protector, wire, this.#context(entry.seq)) } : { seq: entry.seq, entry: wire };
  }

  async #entryOf(row: Row): Promise<AuditEntry | undefined> {
    try {
      const wire = row.data !== undefined
        ? this.#protector && row.data instanceof Uint8Array ? await openJson<unknown>(this.#protector, row.data, this.#context(row.seq)) : undefined
        : this.#protector ? undefined : row.entry; // a plain row beside a protector was planted
      const entry = auditFromWire(wire);
      return entry && entry.seq === row.seq ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  async #lastKnown(): Promise<{ seq: number; hash: string } | undefined> {
    const db = await this.#open();
    let rows: Row[] = [];
    let anchor: AuditAnchor | undefined;
    await transact(db, [ENTRIES, META], "readonly", async (tx) => {
      // the newest rows first: the last readable one is the tail of the chain
      rows = await new Promise<Row[]>((resolve, reject) => {
        const found: Row[] = [];
        const cursor = tx.objectStore(ENTRIES).openCursor(null, "prev");
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c && found.length < 8) { found.push(c.value as Row); c.continue(); } else resolve(found);
        };
        cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB request failed."));
      });
      anchor = await request<AuditAnchor | undefined>(tx.objectStore(META).get(ANCHOR));
    });
    // The highest seq keeps the numbers going, so a damaged tail never makes two entries of one number; the link is the last readable entry's.
    for (const row of rows) {
      const entry = await this.#entryOf(row);
      if (entry) return { seq: rows[0]!.seq, hash: entry.hash };
    }
    if (rows[0]) return { seq: rows[0].seq, hash: AUDIT_ZEROS };
    return anchor && typeof anchor.seq === "number" && typeof anchor.hash === "string" ? { seq: anchor.seq, hash: anchor.hash } : undefined;
  }

  async #all(): Promise<{ entries: (AuditEntry | undefined)[]; key: Uint8Array | undefined; anchor: AuditAnchor | undefined; head: AuditHead | undefined }> {
    if (!(await this.#exists())) return { entries: [], key: undefined, anchor: undefined, head: undefined };
    const db = await this.#open();
    let rows: Row[] = [];
    let anchor: AuditAnchor | undefined;
    let head: AuditHead | undefined;
    await transact(db, [ENTRIES, META], "readonly", async (tx) => {
      rows = await request<Row[]>(tx.objectStore(ENTRIES).getAll());
      anchor = await request<AuditAnchor | undefined>(tx.objectStore(META).get(ANCHOR));
      head = await request<AuditHead | undefined>(tx.objectStore(META).get(HEAD));
    });
    const headOk = head && typeof head.seq === "number" && typeof head.hash === "string" && typeof head.seal === "string";
    const entries = await Promise.all(rows.map((r) => this.#entryOf(r)));
    const valid = anchor && typeof anchor.seq === "number" && typeof anchor.hash === "string" && typeof anchor.seal === "string";
    return { entries, key: await this.#key(false), anchor: anchor === undefined ? undefined : valid ? anchor : { seq: 0, hash: "", prunedAt: "", seal: "" },
      head: head === undefined ? undefined : headOk ? head : { seq: 0, hash: "", seal: "" } };
  }

  // ---- the key ----

  async #key(create: boolean): Promise<Uint8Array | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const stored = (await this.#read(META, SEAL_KEY)) as { data?: Uint8Array; key?: string } | undefined;
      if (stored) {
        try {
          const kept = stored.data !== undefined
            ? this.#protector ? (await openJson<{ key: string }>(this.#protector, stored.data, this.#keyContext())).key : undefined
            : this.#protector ? undefined : stored.key;
          const bytes = typeof kept === "string" ? fromBase64(kept) : undefined;
          return bytes?.length === 32 ? bytes : undefined;
        } catch {
          return undefined;
        }
      }
      if (!create) return undefined;
      const made = randomKey();
      const value = this.#protector ? { data: await sealJson(this.#protector, { key: base64(made) }, this.#keyContext()) } : { key: base64(made) };
      try {
        await this.#write("readwrite", [META], (tx) => { tx.objectStore(META).add(value, SEAL_KEY); });
        return made;
      } catch (error) {
        if ((error as { name?: string } | undefined)?.name !== "ConstraintError") throw error; // another tab made it first: use theirs
      }
    }
    return undefined;
  }

  #keyContext(): string {
    return recordContext(this.#name, META, "key", SEAL_KEY);
  }

  // ---- IndexedDB ----

  async #read(store: string, key: string): Promise<unknown> {
    if (!(await this.#exists())) return undefined;
    const db = await this.#open();
    let value: unknown;
    await transact(db, [store], "readonly", async (tx) => { value = await request<unknown>(tx.objectStore(store).get(key)); });
    return value;
  }

  /** Runs `work` in a transaction and settles when it is done; a refused `add` rejects with the request's own error (`ConstraintError`). */
  async #write(mode: IDBTransactionMode, stores: string[], work: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => { failure ??= (event.target as IDBRequest | null)?.error ?? tx.error; }; // the first request's error is the reason; the others only say aborted
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("IndexedDB transaction aborted."));
      try {
        work(tx);
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Reading must not create the database: where the browser can list them, look first. */
  async #exists(): Promise<boolean> {
    if (this.#db) return true;
    const list = (this.#factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof list !== "function") return true;
    try {
      return (await list.call(this.#factory)).some((d) => d.name === this.#name);
    } catch {
      return true;
    }
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: "seq" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => { // another tab or agent deletes the database (deleteMyData): let it, and open again at next use
          db.close();
          this.#db = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}
