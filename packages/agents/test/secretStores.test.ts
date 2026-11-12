import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  IndexedDbApprovalStore,
  IndexedDbKeyStore,
  IndexedDbSessionStore,
  SecretProtectionError,
  WebCryptoSecretProtector,
  newId,
  type SecretProtector,
  type StoreProblem,
  type TranscriptEntry,
} from "@fadenstack/agents";

/** The encrypted stores (sdk/45 3.3, D2). Port of the .NET protector tests, in the browser's form: a WebCrypto key per user. */

function entry(type: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): TranscriptEntry {
  return { id: newId(), parentId: null, timestamp: at, type, turnId: "t1", status: null, data };
}

const SECRET_TEXT = "The merger with Contoso closes on Friday";
const SECRET_TITLE = SECRET_TEXT;

async function protectorOn(factory: IDBFactory, name = "keys"): Promise<{ protector: WebCryptoSecretProtector; keys: IndexedDbKeyStore }> {
  const keys = new IndexedDbKeyStore({ name, indexedDB: factory });
  return { protector: new WebCryptoSecretProtector(keys), keys };
}

/** Every row of an object store as it is in the database, without the store's own reading. */
async function rawRows(factory: IDBFactory, name: string, store: string): Promise<Record<string, unknown>[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const req = db.transaction([store]).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function putRaw(factory: IDBFactory, name: string, store: string, row: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([store], "readwrite");
      tx.objectStore(store).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

describe("the WebCrypto key", () => {
  it("is a non-extractable AES-GCM key: the page can use it but never read its bytes", async () => {
    const factory = new IDBFactory();
    const { keys } = await protectorOn(factory);
    const key = await keys.key();
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", key)).rejects.toThrow();
  });

  it("is kept in IndexedDB: a later start finds the same key, and two tabs at once agree on one", async () => {
    const factory = new IDBFactory();
    const first = await protectorOn(factory);
    const sealed = await first.protector.protect(new TextEncoder().encode("hello"), "ctx");
    await first.keys.closeAsync();

    const again = await protectorOn(factory);
    expect(new TextDecoder().decode(await again.protector.unprotect(sealed, "ctx"))).toBe("hello");

    const raced = new IDBFactory();
    const [a, b] = [await protectorOn(raced), await protectorOn(raced)];
    const text = await a.protector.protect(new TextEncoder().encode("x"), "ctx");
    await Promise.all([a.keys.key(), b.keys.key()]);
    expect(new TextDecoder().decode(await b.protector.unprotect(text, "ctx"))).toBe("x");
  });

  it("uses a fresh IV for every record, stored in front of the ciphertext", async () => {
    const { protector } = await protectorOn(new IDBFactory());
    const data = new TextEncoder().encode(SECRET_TEXT);
    const records = await Promise.all(Array.from({ length: 40 }, () => protector.protect(data, "ctx")));
    const ivs = records.map((r) => Buffer.from(r.slice(1, 13)).toString("hex"));
    expect(new Set(ivs).size).toBe(40);
    expect(new Set(records.map((r) => Buffer.from(r).toString("hex"))).size).toBe(40);
    expect(records[0]!.length).toBe(1 + 12 + data.length + 16);
  });

  it("binds a record to its place: the same bytes do not decrypt under another store or key name", async () => {
    const { protector } = await protectorOn(new IDBFactory());
    const sealed = await protector.protect(new TextEncoder().encode(SECRET_TEXT), "store-a|1");
    await expect(protector.unprotect(sealed, "store-b|1")).rejects.toBeInstanceOf(SecretProtectionError);
    await expect(protector.unprotect(sealed, "store-a|2")).rejects.toBeInstanceOf(SecretProtectionError);
    expect(new TextDecoder().decode(await protector.unprotect(sealed, "store-a|1"))).toBe(SECRET_TEXT);
  });

  it("refuses a changed record and another user's key, and says nothing of the contents", async () => {
    const mine = await protectorOn(new IDBFactory());
    const theirs = await protectorOn(new IDBFactory());
    const sealed = await mine.protector.protect(new TextEncoder().encode(SECRET_TEXT), "ctx");
    const flipped = sealed.slice();
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    for (const bad of [flipped, sealed.slice(0, 10), new Uint8Array(40)]) {
      const failure = await mine.protector.unprotect(bad, "ctx").then(() => undefined, (e: unknown) => e as Error);
      expect(failure).toBeInstanceOf(SecretProtectionError);
      expect(failure!.message).not.toContain("Contoso");
    }
    await expect(theirs.protector.unprotect(sealed, "ctx")).rejects.toBeInstanceOf(SecretProtectionError);
  });
});

describe("the encrypted session store", () => {
  async function open(factory: IDBFactory, problems: StoreProblem[] = [], name = "sessions", protector?: SecretProtector) {
    return new IndexedDbSessionStore({
      name, indexedDB: factory, keyRange: IDBKeyRange,
      protector: protector ?? (await protectorOn(factory)).protector,
      onProblem: (p) => problems.push(p),
    });
  }

  it("keeps no chat text in the database: what is on the disk is ciphertext", async () => {
    const factory = new IDBFactory();
    const store = await open(factory);
    await store.append("docs", "s1", entry("user.message", { text: SECRET_TEXT }));
    await store.append("docs", "s1", entry("assistant.message", { text: "Noted." }));

    const raw = JSON.stringify([...await rawRows(factory, "sessions", "entries"), ...await rawRows(factory, "sessions", "sessions")], (_, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(raw).not.toContain("Contoso");
    expect(raw).not.toContain(SECRET_TITLE);
    expect(raw).not.toContain("Noted");
    expect((await store.read("docs", "s1")).map((e) => e.data["text"])).toEqual([SECRET_TEXT, "Noted."]);
    expect(await store.list("docs")).toMatchObject([{ id: "s1", title: SECRET_TITLE }]);
    expect(await store.agents()).toEqual(["docs"]);
  });

  it("treats a record under another key as absent, and reports it without its contents", async () => {
    const factory = new IDBFactory();
    const problems: StoreProblem[] = [];
    await (await open(factory, [], "sessions")).append("docs", "s1", entry("user.message", { text: SECRET_TEXT }));
    // The same database, read with a key of its own: the key store of another user, or a lost one.
    const other = await open(factory, problems, "sessions", (await protectorOn(new IDBFactory(), "other")).protector);
    expect(await other.read("docs", "s1")).toEqual([]);
    expect(await other.list("docs")).toEqual([]);
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.every((p) => p.store === "sessions" && p.kind === "undecryptable")).toBe(true);
    expect(JSON.stringify(problems)).not.toContain("Contoso");
  });

  it("treats a record moved to another place, or changed, as absent", async () => {
    const factory = new IDBFactory();
    const problems: StoreProblem[] = [];
    const { protector } = await protectorOn(factory);
    const a = await open(factory, problems, "sessions-a", protector);
    const b = await open(factory, problems, "sessions-b", protector);
    await a.append("docs", "s1", entry("user.message", { text: SECRET_TEXT }));
    await b.append("docs", "s2", entry("user.message", { text: "mine" }));
    const [moved] = await rawRows(factory, "sessions-a", "entries");

    // into another store with the same key: the database's name is part of the additional data
    await putRaw(factory, "sessions-b", "entries", { ...moved, session: "s2", seq: 1 });
    // into another place of the same store: the session and the sequence number are part of it
    await putRaw(factory, "sessions-a", "entries", { ...moved, seq: 7 });
    // changed
    const changed = (moved!["data"] as Uint8Array).slice();
    changed[20] = changed[20]! ^ 1;
    await putRaw(factory, "sessions-a", "entries", { ...moved, seq: 8, data: changed });

    expect((await b.read("docs", "s2")).map((e) => e.data["text"])).toEqual(["mine"]);
    expect((await a.read("docs", "s1")).map((e) => e.data["text"])).toEqual([SECRET_TEXT]);
    expect(problems.length).toBe(3);
  });

  it("writes an earlier SDK's plain records back encrypted, once, and reads them meanwhile", async () => {
    const factory = new IDBFactory();
    // The database as version 1 of the SDK left it: plain rows, no meta store.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open("sessions", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("entries", { keyPath: ["agent", "session", "seq"] });
        open.result.createObjectStore("sessions", { keyPath: ["agent", "id"] }).createIndex("agent", "agent");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const first = entry("user.message", { text: SECRET_TEXT }, "2026-01-01T10:00:00.000Z");
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction(["entries", "sessions"], "readwrite");
      tx.objectStore("entries").put({ agent: "docs", session: "s1", seq: 0, entry: first });
      tx.objectStore("sessions").put({ id: "s1", agent: "docs", started: first.timestamp, lastActivity: first.timestamp, title: SECRET_TITLE, count: 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();

    const problems: StoreProblem[] = [];
    const store = await open(factory, problems);
    expect((await store.read("docs", "s1")).map((e) => e.data["text"])).toEqual([SECRET_TEXT]);
    expect(await store.list("docs")).toMatchObject([{ id: "s1", title: SECRET_TITLE }]);

    const entries = await rawRows(factory, "sessions", "entries");
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("entry");
    expect(entries[0]!["data"]).toBeInstanceOf(Uint8Array);
    expect(await rawRows(factory, "sessions", "sessions")).toMatchObject([{ id: "s1", agent: "docs", data: expect.any(Uint8Array) as unknown }]);
    expect(JSON.stringify(await rawRows(factory, "sessions", "sessions"), (_, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v))).not.toContain(SECRET_TITLE);
    expect(problems).toEqual([]);

    // later entries go on after the migrated one
    await store.append("docs", "s1", entry("assistant.message", { text: "Noted." }));
    expect((await store.read("docs", "s1")).map((e) => e.data["text"])).toEqual([SECRET_TEXT, "Noted."]);
  });

  it("keeps working in plain form where the host supplies no protector", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbSessionStore({ name: "plain", indexedDB: factory, keyRange: IDBKeyRange });
    await store.append("docs", "s1", entry("user.message", { text: SECRET_TEXT }));
    expect((await rawRows(factory, "plain", "entries"))[0]).toHaveProperty("entry");
    expect((await store.read("docs", "s1")).map((e) => e.data["text"])).toEqual([SECRET_TEXT]);
  });
});

describe("the encrypted approval store", () => {
  const at = "2026-11-01T10:00:00.000Z";

  async function open(factory: IDBFactory, problems: StoreProblem[] = [], name = "approvals", protector?: SecretProtector) {
    return new IndexedDbApprovalStore({ name, indexedDB: factory, protector: protector ?? (await protectorOn(factory)).protector, onProblem: (p) => problems.push(p) });
  }

  it("keeps the class and the time as ciphertext, and gives them back", async () => {
    const factory = new IDBFactory();
    const store = await open(factory);
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: at });
    const [row] = await rawRows(factory, "approvals", "approvals");
    expect(row).toMatchObject({ agent: "docs", tool: "write_page" });
    expect(row).not.toHaveProperty("toolClass");
    expect(row).not.toHaveProperty("approvedAt");
    expect(await store.list("docs")).toEqual([{ tool: "write_page", toolClass: "write", approvedAt: at }]);
    expect(await store.agents()).toEqual(["docs"]);
  });

  it("treats a record under another key, or moved to another tool, as absent -- and still lets the person remove it", async () => {
    const factory = new IDBFactory();
    const problems: StoreProblem[] = [];
    const store = await open(factory);
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: at });
    const [row] = await rawRows(factory, "approvals", "approvals");
    await putRaw(factory, "approvals", "approvals", { ...row, tool: "delete_page" }); // the same bytes, another tool: the grant of a safer tool must not become a destructive one's

    const reader = await open(factory, problems);
    expect((await reader.list("docs")).map((a) => a.tool)).toEqual(["write_page"]);
    expect(problems).toMatchObject([{ store: "approvals", kind: "undecryptable", agent: "docs" }]);

    const other = await open(factory, problems, "approvals", (await protectorOn(new IDBFactory(), "x")).protector);
    expect(await other.list("docs")).toEqual([]);
    await other.remove("docs");
    expect(await rawRows(factory, "approvals", "approvals")).toEqual([]);
  });

  it("writes an earlier SDK's plain records back encrypted", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("approvals", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("approvals", { keyPath: ["agent", "tool"] }).createIndex("agent", "agent");
      };
      open.onsuccess = () => {
        const tx = open.result.transaction(["approvals"], "readwrite");
        tx.objectStore("approvals").put({ agent: "docs", tool: "write_page", toolClass: "write", approvedAt: at });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
      open.onerror = () => reject(open.error);
    });
    const store = await open(factory);
    expect(await store.list("docs")).toEqual([{ tool: "write_page", toolClass: "write", approvedAt: at }]);
    expect((await rawRows(factory, "approvals", "approvals"))[0]).not.toHaveProperty("toolClass");
  });
});
