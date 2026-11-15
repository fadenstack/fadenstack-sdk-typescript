import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { WebCryptoSecretProtector, type KeySource } from "@fadenstack/agents";
import { IndexedDbMcpServerStore, McpConfigError, McpStoreError, MemoryMcpServerStore, openMcpServerStore, checkServer } from "@fadenstack/mcp";

import { server } from "./rig.js";

const SECRET = "Bearer s3cret-token-value-0123456789";

/** The raw records of a database, as IndexedDB holds them (what a copy of the browser profile would carry). */
function rawRows(factory: IDBFactory, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction(["servers"], "readonly").objectStore("servers").getAll();
      request.onsuccess = () => { db.close(); resolve(request.result as unknown[]); };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

/** What the bytes of every row say as text, however they are laid out: a structured clone cannot hide a string in a field this misses. */
function everything(rows: unknown[]): string {
  const seen: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") seen.push(value);
    else if (value instanceof Uint8Array) seen.push(new TextDecoder("latin1").decode(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => { seen.push(k); walk(v); });
  };
  rows.forEach(walk);
  return seen.join("\n");
}

describe("the person's servers in IndexedDB", () => {
  it("adds, lists and removes a server by label, with its headers back in the clear", async () => {
    const store = new IndexedDbMcpServerStore({ indexedDB: new IDBFactory() });

    await store.save(server("zeta", "https://z.example.com/mcp"));
    await store.save(server("alpha", "https://a.example.com/mcp", { headers: { Authorization: SECRET, "X-Team": "red" }, trusted: true, toolClasses: { read_it: "read" }, callTimeoutS: 30 }));
    await store.save(server("alpha", "https://a.example.com/v2", { headers: { Authorization: SECRET } })); // the same label replaces

    const [alpha, zeta] = await store.list();
    expect(alpha).toEqual({ label: "alpha", url: "https://a.example.com/v2", headers: { Authorization: SECRET }, enabled: true, trusted: false, toolClasses: {}, reviewed: true });
    expect(zeta!.label).toBe("zeta");
    expect((await store.get("alpha"))?.headers).toEqual({ Authorization: SECRET });
    expect(await store.get("nothing")).toBeUndefined();
    expect(await store.remove("zeta")).toBe(true);
    expect(await store.remove("zeta")).toBe(false);
    expect((await store.list()).map((s) => s.label)).toEqual(["alpha"]);
    store.close();
  });

  it("does not keep a header value readable in the stored record", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMcpServerStore({ indexedDB: factory });
    await store.save(server("notes", "https://mcp.example.com/mcp", { headers: { Authorization: SECRET, "X-Api-Key": "key-0123456789-abcdef" } }));

    const rows = await rawRows(factory, store.databaseName);

    expect(rows).toHaveLength(1);
    const text = everything(rows);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("key-0123456789");
    expect(text).toContain("https://mcp.example.com/mcp"); // the address and the header names are for the list to show
    expect(text).toContain("Authorization");
    expect((rows[0] as { sealed: Uint8Array }).sealed).toBeInstanceOf(Uint8Array);
    store.close();
  });

  it("seals with the person's own key (the one the sessions use), and keeps it across opens", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbMcpServerStore({ indexedDB: factory });
    await first.save(server("notes", "https://mcp.example.com/mcp", { headers: { Authorization: SECRET } }));
    first.close();

    const second = new IndexedDbMcpServerStore({ indexedDB: factory });
    expect((await second.get("notes"))?.headers).toEqual({ Authorization: SECRET });
    second.close();

    const names = await factory.databases();
    expect(names.map((d) => d.name).sort()).toEqual(["fadenstack-keys:standalone:standalone", "fadenstack-mcp:standalone:standalone"]);
  });

  it("keeps a database per principal, and standalone is its own principal", async () => {
    const factory = new IDBFactory();
    let principal: { tenantId: string; userId: string } | undefined;
    const store = new IndexedDbMcpServerStore({ indexedDB: factory, principal: () => principal });
    await store.save(server("mine", "https://a.example.com/"));
    principal = { tenantId: "t1", userId: "anna" };
    await store.save(server("annas", "https://b.example.com/", { headers: { Authorization: SECRET } }));
    principal = { tenantId: "t1", userId: "ben" };

    expect(await store.list()).toEqual([]); // another person sees nothing
    principal = { tenantId: "t1", userId: "anna" };
    expect((await store.list()).map((s) => s.label)).toEqual(["annas"]);
    principal = undefined;
    expect((await store.list()).map((s) => s.label)).toEqual(["mine"]);
    expect(store.databaseName).toBe("fadenstack-mcp");
    expect((await factory.databases()).map((d) => d.name)).toContain("fadenstack-mcp:t1:anna");
    store.close();
  });

  it("lists a record whose key is gone without its headers, and off", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMcpServerStore({ indexedDB: factory });
    await store.save(server("notes", "https://mcp.example.com/mcp", { headers: { Authorization: SECRET } }));
    store.close();
    // the key database is deleted (deleteMyData removes it with the person's data): the sealed headers can never be read again
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase("fadenstack-keys:standalone:standalone");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });

    const again = new IndexedDbMcpServerStore({ indexedDB: factory });
    const [kept] = await again.list();

    expect(kept).toMatchObject({ label: "notes", headers: {}, enabled: false, headersUnreadable: true });
    again.close();
  });

  it("does not decrypt a record moved to another label", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMcpServerStore({ indexedDB: factory });
    await store.save(server("one", "https://a.example.com/", { headers: { Authorization: SECRET } }));
    const [row] = (await rawRows(factory, store.databaseName)) as { label: string }[];
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(store.databaseName);
      open.onsuccess = () => {
        const tx = open.result.transaction(["servers"], "readwrite");
        tx.objectStore("servers").put({ ...row, label: "two" }, "two");
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });

    expect((await store.get("two"))).toMatchObject({ headersUnreadable: true, headers: {} });
    expect((await store.get("one"))?.headers).toEqual({ Authorization: SECRET });
    store.close();
  });

  it("refuses to keep headers it cannot seal, rather than keep them in the clear", async () => {
    const none: KeySource = { key: () => Promise.reject(new Error("no key")) };
    const factory = new IDBFactory();
    const store = new IndexedDbMcpServerStore({ indexedDB: factory, protector: new WebCryptoSecretProtector(none) });

    await expect(store.save(server("notes", "https://a.example.com/", { headers: { Authorization: SECRET } }))).rejects.toThrow();
    expect(everything(await rawRows(factory, store.databaseName))).not.toContain("s3cret");
    await store.save(server("plain", "https://a.example.com/")); // a server without headers has nothing to seal
    expect((await store.list()).map((s) => s.label)).toEqual(["plain"]);
    store.close();
  });

  it("takes a label without regard to case once, and renames in one step", async () => {
    for (const store of [new IndexedDbMcpServerStore({ indexedDB: new IDBFactory() }), new MemoryMcpServerStore()]) {
      await store.save(server("Notes", "https://a.example.com/"));
      await expect(store.save(server("notes", "https://b.example.com/"))).rejects.toThrow(McpStoreError);
      await store.save(server("Files", "https://b.example.com/"), "Notes"); // a rename
      expect((await store.list()).map((s) => s.label)).toEqual(["Files"]);
      store.close();
    }
  });

  it("tells the listeners about a change, and a listener that fails does not fail it", async () => {
    const store = new MemoryMcpServerStore();
    let told = 0;
    const stop = store.onChanged(() => { told++; throw new Error("a bad listener"); });
    await store.save(server("a", "https://a.example.com/"));
    await store.remove("a");
    stop();
    await store.save(server("b", "https://a.example.com/"));
    expect(told).toBe(2);
  });

  it("picks IndexedDB where there is one and memory where there is not", () => {
    expect(openMcpServerStore({ indexedDB: new IDBFactory() })).toBeInstanceOf(IndexedDbMcpServerStore);
    const saved = globalThis.indexedDB;
    try {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined as never;
      expect(openMcpServerStore()).toBeInstanceOf(MemoryMcpServerStore);
    } finally {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved;
    }
  });
});

describe("the rules a server must keep", () => {
  it.each([
    [{ label: "", url: "https://a.example.com/" }, /needs a label/],
    [{ label: " x", url: "https://a.example.com/" }, /A label is/],
    [{ label: "x".repeat(41), url: "https://a.example.com/" }, /A label is/],
    [{ label: "x<y>", url: "https://a.example.com/" }, /A label is/],
    [{ label: "x", url: "ftp://a.example.com/" }, /http or https/],
    [{ label: "x", url: "javascript:alert(1)" }, /http or https/],
    [{ label: "x", url: "" }, /not a web address/],
    [{ label: "x", url: `https://a.example.com/${"a".repeat(2100)}` }, /too long/],
    [{ label: "x", url: "https://a.example.com/", headers: { "Bad Name": "v" } }, /header name/],
    [{ label: "x", url: "https://a.example.com/", headers: { Host: "evil" } }, /set by the transport/],
    [{ label: "x", url: "https://a.example.com/", headers: { Authorization: "a\nb" } }, /not valid/],
  ])("refuses %j", (candidate, message) => {
    expect(() => checkServer(candidate)).toThrow(McpConfigError);
    expect(() => checkServer(candidate)).toThrow(message);
  });

  it("never puts a header value in an error", () => {
    try {
      checkServer({ label: "x", url: "https://a.example.com/", headers: { Authorization: "line one\nSECRET-VALUE" } });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-VALUE");
    }
  });

  it("allows plain http for this computer, https anywhere, and keeps a local-network host to wait for the switch", () => {
    for (const url of ["http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]:8080/mcp", "https://a.example.com/mcp", "http://10.0.0.5/mcp"]) {
      expect(() => checkServer({ label: "x", url })).not.toThrow();
    }
    expect(() => checkServer({ label: "x", url: "http://localhost.evil.com/mcp" })).toThrow(/plain http/);
    expect(() => checkServer({ label: "x", url: "http://10.0.0.5/mcp", headers: { "X-Key": "k" } })).toThrow(/plain http/);
  });
});
