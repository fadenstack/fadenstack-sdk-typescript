import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_ZEROS,
  AuditDecisions,
  AuditOutcomes,
  AuditProblems,
  AuditRetention,
  IndexedDbAuditLog,
  MachinePolicy,
  MemoryAuditLog,
  WebCryptoSecretProtector,
  argumentsSha256,
  auditAnchorSeal,
  auditHeadSeal,
  auditCanonicalText,
  auditFromWire,
  auditHash,
  auditSeal,
  auditToWire,
  recordContext,
  type AuditEntry,
  type AuditLog,
  type AuditRecord,
  type SecretProtector,
} from "@fadenstack/agents";

/**
 * The person's record of tool calls (sdk/51 8.10): the chain's format (shared vectors with the .NET SDK), the IndexedDB log, and what
 * verify finds when an entry is changed, deleted, swapped, borrowed or forged. ASVS 5.0 V16 (security logging: integrity).
 */
describe("the record of tool calls", () => {
  let factory: IDBFactory;
  let protector: SecretProtector;
  let now = new Date("2026-11-16T09:30:00.000Z");

  beforeEach(async () => {
    factory = new IDBFactory();
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    now = new Date("2026-11-16T09:30:00.000Z");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    protector = new WebCryptoSecretProtector({ key: () => Promise.resolve(key) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const open = (name = "fadenstack-audit:t:u") => new IndexedDbAuditLog({ name, protector, indexedDB: factory, clock: () => now });

  const record = (tool = "read_page", decision: string = AuditDecisions.mode, outcome: string = AuditOutcomes.ran, app = "Word"): AuditRecord => ({
    app, agent: "writer", chat: "chat-1", turn: "turn-1", tool, class: "read", source: "host", decision, outcome,
    argumentsSha256: "a".repeat(64),
  });

  // ---- reading and writing the database behind the log's back, as someone with the page's console would ----

  function raw(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function rows(name: string, store: string): Promise<Record<string, unknown>[]> {
    const db = await raw(name);
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction([store]).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function change(name: string, store: string, work: (s: IDBObjectStore) => void): Promise<void> {
    const db = await raw(name);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([store], "readwrite");
        work(tx.objectStore(store));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const context = (name: string, seq: number) => recordContext(name, "entries", "entries", String(seq));

  async function wireOf(name: string, seq: number): Promise<Record<string, unknown>> {
    const row = (await rows(name, "entries")).find((r) => r["seq"] === seq)!;
    return JSON.parse(new TextDecoder().decode(await protector.unprotect(row["data"] as Uint8Array, context(name, seq)))) as Record<string, unknown>;
  }

  async function putWire(name: string, seq: number, wire: Record<string, unknown>): Promise<void> {
    const data = await protector.protect(new TextEncoder().encode(JSON.stringify(wire)), context(name, seq));
    await change(name, "entries", (s) => { s.put({ seq, data }); });
  }

  async function sealKeyOf(name: string): Promise<Uint8Array> {
    const row = (await rows(name, "meta")).find((r) => r["data"] !== undefined) as unknown as { data: Uint8Array };
    const stored = JSON.parse(new TextDecoder().decode(await protector.unprotect(row.data, recordContext(name, "meta", "key", "seal")))) as { key: string };
    return Uint8Array.from(atob(stored.key), (c) => c.charCodeAt(0));
  }

  /** An entry as an attacker who holds the key would forge it: hash and seal both hold. */
  async function resealed(wire: Record<string, unknown>, key: Uint8Array): Promise<Record<string, unknown>> {
    const entry = auditFromWire(wire)!;
    const hash = await auditHash(entry);
    return auditToWire({ ...entry, hash, seal: await auditSeal(key, hash) });
  }

  const append = async (log: AuditLog, count: number, make: () => AuditRecord = () => record()) => {
    for (let i = 0; i < count; i++) await log.append(make());
  };

  // ---- the format, the same vectors as the .NET SDK ----

  const VECTOR_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
  const vectorOne = async (): Promise<Omit<AuditEntry, "hash" | "seal">> => ({
    seq: 1, time: "2026-11-16T09:30:00.123Z", kind: "tool", app: "Word", agent: "writer", chat: "chat-1", turn: "turn-1", tool: "read_page",
    class: "read", source: "host", decision: "mode", outcome: "ran", argumentsSha256: await argumentsSha256('{"page":1}'), prev: AUDIT_ZEROS,
  });
  const vectorTwo = async (): Promise<Omit<AuditEntry, "hash" | "seal">> => ({
    seq: 2, time: "2026-11-16T09:30:05.007Z", kind: "tool", app: "Excel", agent: "writer", chat: "chat-1", turn: "turn-2", tool: "delete_page",
    class: "destructive", source: "mcp", server: "files", decision: "asked_approved", scope: "once", outcome: "ran",
    argumentsSha256: await argumentsSha256('{"name":"caf\u00e9"}'), prev: "bd9a85855ec1225e80f87aca01e2df62576b870b10dde8646a8f753e38fafea9",
  });

  it("the shared vectors give the same arguments hashes, hashes and seals as the other SDK", async () => {
    const one = await vectorOne();
    const two = await vectorTwo();
    expect(one.argumentsSha256).toBe("70fb0185588d2e765454a7927f2792ae2b6faa2516781deb69864246e0803d05");
    expect(two.argumentsSha256).toBe("645fa443126a8954fc6d871912b8fc67bc2ee8feae417efe55546251962ca74d"); // UTF-8
    expect(await auditHash(one)).toBe("bd9a85855ec1225e80f87aca01e2df62576b870b10dde8646a8f753e38fafea9");
    expect(await auditSeal(VECTOR_KEY, await auditHash(one))).toBe("91k1kG1HT7VKBq8H4KqYLxwIOpCel/S/XC3OSfDoGfg=");
    expect(await auditHash(two)).toBe("4ede970e8bfea453d7762d5b94669e6ec36fb8b6175ff9419fcc61228dffc6a2");
    expect(await auditSeal(VECTOR_KEY, await auditHash(two))).toBe("W96Za/zLEg2/Eopq8rv7EgtpDs/Jbc6h/mUCQblIsO8=");
    expect(await auditAnchorSeal(VECTOR_KEY, 7, await auditHash(one))).toBe("k1NEiONJG9RFLUFaoPd4RhaN7N+bJVDg5RLzCmrVrbQ=");
    expect(await auditHeadSeal(VECTOR_KEY, 7, await auditHash(one))).toBe("kQnmGQD/HVREn3S+2Wge+RAR7wEUNYQggSql1Ys2i+w=");
  });

  it("the canonical text is the version and the fields in order, with nothing for an absent one", async () => {
    expect(auditCanonicalText(await vectorOne())).toBe(
      "fadenstack.audit.v1\n1\n2026-11-16T09:30:00.123Z\ntool\nWord\nwriter\nchat-1\nturn-1\nread_page\nread\nhost\n\nmode\n\nran\n"
      + `70fb0185588d2e765454a7927f2792ae2b6faa2516781deb69864246e0803d05\n${AUDIT_ZEROS}`);
  });

  // ---- the log ----

  it("numbers entries from one, links them, and verifies intact", async () => {
    const log = open();
    const first = await log.append(record());
    now = new Date(now.getTime() + 1000);
    const second = await log.append(record("add_comment", AuditDecisions.askedApproved));

    expect([first.seq, first.prev]).toEqual([1, AUDIT_ZEROS]);
    expect([second.seq, second.prev]).toEqual([2, first.hash]);
    expect(await log.verify()).toEqual({ intact: true, entries: 2, firstSeq: 1, firstTime: "2026-11-16T09:30:00.000Z", lastTime: "2026-11-16T09:30:01.000Z" });
  });

  it("an empty log is intact, and what is on disk holds no readable text", async () => {
    const log = open();
    expect((await log.verify()).intact).toBe(true);
    await log.append(record("read_page_secret_name"));

    const everything = JSON.stringify([...await rows("fadenstack-audit:t:u", "entries"), ...await rows("fadenstack-audit:t:u", "meta")],
      (_, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
    const readable = (await rows("fadenstack-audit:t:u", "entries")).map((r) => new TextDecoder().decode(r["data"] as Uint8Array)).join("");
    expect(readable).not.toContain("read_page_secret_name");
    expect(everything).not.toContain("writer");
  });

  it("another instance carries on the same chain", async () => {
    await open().append(record());
    expect((await open().append(record())).seq).toBe(2);
    expect((await open().verify()).intact).toBe(true);
  });

  it("two writers of two apps in parallel never fork the chain", async () => {
    const one = open();
    const two = open(); // another tab, another app of the origin: its own instance, the same database
    const entries = await Promise.all([
      ...Array.from({ length: 20 }, () => one.append(record("read_page", AuditDecisions.mode, AuditOutcomes.ran, "Word"))),
      ...Array.from({ length: 20 }, () => two.append(record("read_page", AuditDecisions.mode, AuditOutcomes.ran, "Excel"))),
    ]);

    expect(entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const result = await one.verify();
    expect(result).toMatchObject({ intact: true, entries: 40 });
  });

  it("a changed field is found at its entry", async () => {
    const log = open();
    await append(log, 4);
    await putWire("fadenstack-audit:t:u", 3, { ...(await wireOf("fadenstack-audit:t:u", 3)), decision: AuditDecisions.askedApproved }); // hash and seal left as they were

    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 3, problem: AuditProblems.hashMismatch });
  });

  it("a deleted entry is found where the number is missing", async () => {
    const log = open();
    await append(log, 4);
    await change("fadenstack-audit:t:u", "entries", (s) => { s.delete(2); });

    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.seqGap });
  });

  it("swapped entries are found", async () => {
    const log = open();
    await append(log, 4);
    const name = "fadenstack-audit:t:u";
    const [two, three] = [await wireOf(name, 2), await wireOf(name, 3)];
    await putWire(name, 2, three); // stored under the other's number, even re-sealed by someone who holds the protector
    await putWire(name, 3, two);

    const result = await log.verify();

    expect(result.intact).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("an entry from another person's log does not hold", async () => {
    const mine = open("fadenstack-audit:t:mine");
    const theirs = open("fadenstack-audit:t:theirs");
    await append(mine, 3); // the same fields and times: only the keys differ
    await append(theirs, 3);
    const theirWire = await wireOf("fadenstack-audit:t:theirs", 2);

    await putWire("fadenstack-audit:t:mine", 2, theirWire); // as someone who can seal under this person's protector would plant it
    expect(await mine.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.sealMismatch });

  });

  it("a row copied as it is from another person's database cannot be opened", async () => {
    const mine = open("fadenstack-audit:t:mine");
    const theirs = open("fadenstack-audit:t:theirs");
    await append(mine, 3);
    await append(theirs, 3);
    const theirRow = (await rows("fadenstack-audit:t:theirs", "entries")).find((r) => r["seq"] === 2)!;

    await change("fadenstack-audit:t:mine", "entries", (s) => { s.put(theirRow); });

    expect(await mine.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.unreadable });
  });

  it("a forged seal does not hold", async () => {
    const log = open();
    await append(log, 3);
    const name = "fadenstack-audit:t:u";
    const wire = await wireOf(name, 2);
    await putWire(name, 2, { ...wire, seal: await auditSeal(new Uint8Array(32), wire["hash"] as string) });

    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.sealMismatch });
  });

  it("an entry that links to the wrong predecessor is found even when hash and seal hold", async () => {
    const log = open();
    await append(log, 3);
    const name = "fadenstack-audit:t:u";
    const key = await sealKeyOf(name);
    await putWire(name, 2, await resealed({ ...(await wireOf(name, 2)), prev: "a".repeat(64) }, key)); // someone who holds the key, linking elsewhere

    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.prevMismatch });
  });

  it("an entry that cannot be read is found, without its content", async () => {
    const log = open();
    await append(log, 3);
    await change("fadenstack-audit:t:u", "entries", (s) => { s.put({ seq: 2, data: new Uint8Array([1, 2, 3]) }); });

    const result = await log.verify();

    expect(result).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.unreadable });
    expect(JSON.stringify(result)).not.toContain("read_page");
  });

  it("a damaged last entry does not stop the log: the next one is written after it and verify reports the damage", async () => {
    const log = open();
    await append(log, 1);
    await change("fadenstack-audit:t:u", "entries", (s) => { s.put({ seq: 2, data: new Uint8Array([9, 9, 9]) }); });

    const next = await log.append(record());

    expect(next.seq).toBe(3);
    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 2, problem: AuditProblems.unreadable });
  });

  // ---- the sealed head: the end of the log ----

  const NAME = "fadenstack-audit:t:u";

  it("a tail cut by one entry or by several is found", async () => {
    const log = open();
    await append(log, 5);

    await change(NAME, "entries", (s) => { s.delete(5); });
    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 5, problem: AuditProblems.headMismatch });

    await change(NAME, "entries", (s) => { s.delete(4); s.delete(3); });
    expect(await log.verify()).toMatchObject({ brokenAtSeq: 3, problem: AuditProblems.headMismatch });

    await change(NAME, "entries", (s) => { s.clear(); });
    expect(await log.verify()).toMatchObject({ intact: false, problem: AuditProblems.headMismatch }); // everything gone
  });

  it("a deleted head is found, and a log from before the head takes one with its next append", async () => {
    const log = open();
    await append(log, 3);
    await change(NAME, "meta", (s) => { s.delete("head"); });

    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 3, problem: AuditProblems.headMissing });

    await log.append(record()); // a valid chain without a head: the head is written once, with this entry
    expect((await log.verify()).intact).toBe(true);
  });

  it("a forged or stale head is found", async () => {
    const log = open();
    await append(log, 3);
    const head = (await rows(NAME, "meta")).find((r) => r["seq"] === 3)!;

    await change(NAME, "meta", (s) => { s.put({ ...head, seq: 2 }, "head"); }); // another number, the old seal
    expect((await log.verify()).problem).toBe(AuditProblems.headMismatch);

    await change(NAME, "meta", (s) => { s.put("not a head", "head"); });
    expect((await log.verify()).problem).toBe(AuditProblems.headMismatch);

    await change(NAME, "meta", (s) => { s.put(head, "head"); });
    expect((await log.verify()).intact).toBe(true);
  });

  it("pruning leaves the head alone", async () => {
    const log = open();
    await append(log, 2);
    const before = JSON.stringify((await rows(NAME, "meta")).filter((r) => r["seq"] === 2));
    now = new Date(now.getTime() + 400 * 86_400_000);
    await log.prune(180);

    expect(JSON.stringify((await rows(NAME, "meta")).filter((r) => r["seq"] === 2 && r["prunedAt"] === undefined))).toBe(before);
    expect((await log.verify()).intact).toBe(true);
  });

  // ---- retention ----

  const threeAtOneHundredDays = async (log: AuditLog) => {
    for (let i = 0; i < 3; i++) {
      await log.append(record());
      now = new Date(now.getTime() + 100 * 86_400_000);
    }
  };

  it("pruning removes the old start and leaves a sealed anchor, so the rest still verifies", async () => {
    const log = open();
    await threeAtOneHundredDays(log); // entries at day 0, 100 and 200; now is day 300: 180 days keep the last one

    expect(await log.prune(180)).toBe(2);

    expect(await log.verify()).toMatchObject({ intact: true, entries: 1, firstSeq: 3 });
    expect((await rows("fadenstack-audit:t:u", "meta")).length).toBe(3); // the key, the head and the anchor
    expect((await log.append(record())).seq).toBe(4); // the chain goes on
    expect((await log.verify()).intact).toBe(true);
  });

  it("without its anchor or with a changed one a pruned log does not verify", async () => {
    const log = open();
    await threeAtOneHundredDays(log);
    await log.prune(180);
    const name = "fadenstack-audit:t:u";

    await change(name, "meta", (s) => { s.put({ seq: 5, hash: "b".repeat(64), prunedAt: "x", seal: "x" }, "anchor"); });
    expect((await log.verify()).problem).toBe(AuditProblems.anchorMismatch);

    await change(name, "meta", (s) => { s.delete("anchor"); });
    expect(await log.verify()).toMatchObject({ intact: false, brokenAtSeq: 3, problem: AuditProblems.anchorMissing });
  });

  it("pruning everything leaves an empty log that carries on from the anchor", async () => {
    const log = open();
    await append(log, 2);
    now = new Date(now.getTime() + 400 * 86_400_000);

    expect(await log.prune(180)).toBe(2);

    expect((await log.verify()).intact).toBe(true);
    expect((await log.append(record())).seq).toBe(3);
    expect((await log.verify()).intact).toBe(true);
  });

  it("nothing old means nothing removed and no anchor", async () => {
    const log = open();
    await append(log, 1);

    expect(await log.prune(180)).toBe(0);
    expect((await rows("fadenstack-audit:t:u", "meta")).length).toBe(2); // only the key and the head
  });

  // ---- export ----

  it("the csv has the verification on top and one row per entry, and is safe in a spreadsheet", async () => {
    const log = open();
    await log.append({ ...record('=HYPERLINK("x")'), server: "a,b" });

    const lines = (await log.export("csv")).split("\r\n");

    expect(lines[0]).toBe("verification,intact,entries,first_seq,first_time,last_time,broken_at_seq,problem");
    expect(lines[1]).toBe("verification,true,1,1,2026-11-16T09:30:00.000Z,2026-11-16T09:30:00.000Z,,");
    expect(lines[3]).toBe("seq,time,kind,app,agent,chat,turn,tool,class,source,server,decision,scope,outcome,arguments_sha256,prev,hash,seal");
    expect(lines[4]).toContain("'=HYPERLINK(\"\"x\"\")");
    expect(lines[4]).toContain('"a,b"');
  });

  it("the csv of a damaged log says so at the top", async () => {
    const log = open();
    await append(log, 2);
    await change("fadenstack-audit:t:u", "entries", (s) => { s.put({ seq: 2, data: new Uint8Array([1]) }); });

    expect((await log.export("csv")).split("\r\n")[1]).toMatch(/^verification,false,1,1,/);
  });

  it("the html is one page with escaped text, inline style, no script and no outside resource", async () => {
    const log = open();
    await log.append({ ...record("<script>alert(1)</script>"), server: '"><img src=http://evil.test/x>' });

    const page = await log.export("html");

    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    const tags = new Set([...page.matchAll(/<(\/?[a-zA-Z0-9]+)/g)].map((m) => m[1]!.replace("/", "")));
    for (const tag of tags) expect(["html", "head", "meta", "title", "style", "body", "h1", "p", "span", "table", "thead", "tbody", "tr", "th", "td"]).toContain(tag);
    expect(page).not.toContain("@import");
    expect(page).not.toContain("url(");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("<table>");
    expect(page).toContain("Intact");
  });

  // ---- in memory, and the policy ----

  it("the memory log keeps the same chain and checks", async () => {
    const log = new MemoryAuditLog(() => now);
    await append(log, 2);
    now = new Date(now.getTime() + 400 * 86_400_000);

    expect((await log.verify()).intact).toBe(true);
    expect(await log.prune(180)).toBe(2);
    expect((await log.append(record())).seq).toBe(3);
    expect((await log.verify()).intact).toBe(true);
  });

  it.each([
    ['{"auditRetentionDays":30}', 30, 0],
    ['{"auditRetentionDays":3650}', 3650, 0],
    ['{"auditRetentionDays":29}', 180, 1],
    ['{"auditRetentionDays":3651}', 180, 1],
    ['{"auditRetentionDays":"90"}', 180, 1],
    ['{"auditRetentionDays":90.5}', 180, 1],
  ])("the machine policy %s sets the retention within bounds, and an odd value is reported", (json, days, warnings) => {
    const policy = MachinePolicy.fromJson(json);

    expect(policy.auditRetentionDays).toBe(days);
    expect(policy.warnings).toHaveLength(warnings);
    expect(policy.locked).toContain("auditRetentionDays");
  });

  it("without a policy the retention is not set, and the agent keeps 180 days", () => {
    expect(MachinePolicy.fromJson("{}").auditRetentionDays).toBeUndefined();
    expect(AuditRetention.defaultDays).toBe(180);
  });
});
