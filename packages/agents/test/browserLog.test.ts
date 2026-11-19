import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword, type LogEvent } from "@fadenstack/client";
import { ApprovalDecision, BROWSER_LOG_DATABASE, BrowserLog, FadenstackAgent, userStoreName, type StoredLogEntry } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";

// The small, content-free log in the browser (0.3.1): bounded, batched, never failing the caller, per person, removed with the person's data.

const PERSON = { tenantId: "tenant-1", userId: "user-1" };

function event(n: number, level: LogEvent["level"] = "information"): LogEvent {
  return { category: "Fadenstack.Agents", eventId: 2000 + (n % 30), eventName: "Probe", level, message: `Probe ${n}`, fields: { N: n, Name: "x" } };
}

describe("the browser log", () => {
  let clock = Date.parse("2026-11-18T10:00:00.000Z");
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse("2026-11-18T10:00:00.000Z");
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the event as it is plus the time, and nothing else", async () => {
    const log = new BrowserLog({ now });
    const scoped: LogEvent = { ...event(1), scope: { ConversationId: "c-1", TurnId: "t-1" } };
    log.log(scoped);
    log.log(event(2));
    const entries = await log.entries();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ ...scoped, at: "2026-11-18T10:00:00.000Z" });
    expect(Object.keys(entries[0]!).sort()).toEqual([...Object.keys(scoped), "at"].sort());
    expect(Object.keys(entries[1]!).sort()).toEqual([...Object.keys(event(2)), "at"].sort());
  });

  it("keeps at most maxEntries, the oldest dropped first", async () => {
    const log = new BrowserLog({ maxEntries: 10, batchSize: 4, now });
    for (let n = 0; n < 27; n++) log.log(event(n));
    const entries = await log.entries();

    expect(entries.map((e) => e.fields["N"])).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
  });

  it("drops entries older than maxAgeDays as it writes", async () => {
    const log = new BrowserLog({ maxAgeDays: 7, now });
    log.log(event(1));
    await log.flush();
    clock += 3 * 86_400_000;
    log.log(event(2));
    await log.flush();
    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([1, 2]); // 3 days: both stay
    clock += 5 * 86_400_000; // entry 1 is 8 days old, entry 2 is 5
    log.log(event(3));
    const entries = await log.entries();

    expect(entries.map((e) => e.fields["N"])).toEqual([2, 3]);
  });

  it("writes in batches: a count or a short timer, never one transaction per entry", async () => {
    const probe = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("probe"); open.onsuccess = () => resolve(open.result); });
    probe.close();
    const spy = vi.spyOn(Object.getPrototypeOf(probe) as IDBDatabase, "transaction");
    const log = new BrowserLog({ batchSize: 50, flushMs: 20, now });
    for (let n = 0; n < 120; n++) log.log(event(n));
    await log.flush();
    const writes = spy.mock.calls.filter((c: unknown[]) => c[1] === "readwrite").length;
    expect(writes).toBeLessThanOrEqual(3); // 50 + 50 + 20
    expect(writes).toBeGreaterThanOrEqual(1);

    const before = spy.mock.calls.filter((c: unknown[]) => c[1] === "readwrite").length;
    log.log(event(1000));
    expect(spy.mock.calls.filter((c: unknown[]) => c[1] === "readwrite").length).toBe(before); // queued, not yet written
    await new Promise((resolve) => setTimeout(resolve, 120)); // the timer hands it over
    expect(spy.mock.calls.filter((c: unknown[]) => c[1] === "readwrite").length).toBe(before + 1);
    expect((await log.entries()).at(-1)!.fields["N"]).toBe(1000);
  });

  it("a failing database drops the entries and counts them; the caller never sees it", async () => {
    const broken = { open() { const request: Record<string, unknown> = {}; queueMicrotask(() => (request["onerror"] as (() => void) | undefined)?.()); return request; } } as unknown as IDBFactory;
    const log = new BrowserLog({ factory: broken, batchSize: 3, now });
    expect(() => { for (let n = 0; n < 7; n++) log.log(event(n)); }).not.toThrow();
    await log.flush();

    expect(log.dropped).toBe(7);
    expect(await log.entries()).toEqual([]);
  });

  it("a queue that cannot be written never grows without bound", () => {
    const never = { open() { return {}; } } as unknown as IDBFactory; // never answers
    const log = new BrowserLog({ factory: never, maxEntries: 5, batchSize: 1000, flushMs: 60_000, now });
    for (let n = 0; n < 12; n++) log.log(event(n));
    expect(log.dropped).toBe(7);
  });

  it("minLevel keeps only entries at or above it", async () => {
    const log = new BrowserLog({ minLevel: "warning", now });
    log.log(event(1, "debug"));
    log.log(event(2, "information"));
    log.log(event(3, "warning"));
    log.log(event(4, "error"));

    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([3, 4]);
  });

  it("entries go to the signed-in person's database; the earlier ones stay where they were", async () => {
    const log = new BrowserLog({ now });
    log.log(event(1)); // nobody known yet
    log.usePrincipal(PERSON);
    log.log(event(2));
    await log.flush();

    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([2]);
    const names = (await indexedDB.databases()).map((d) => d.name).sort();
    expect(names).toEqual([BROWSER_LOG_DATABASE, userStoreName(BROWSER_LOG_DATABASE, PERSON)].sort());
    expect(userStoreName(BROWSER_LOG_DATABASE, PERSON)).toBe("fadenstack-log:tenant-1:user-1");
    log.usePrincipal(undefined);
    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([1]); // not moved
  });

  it("without IndexedDB the entries stay in memory with the same bounds", async () => {
    const log = new BrowserLog({ factory: undefined, maxEntries: 3, maxAgeDays: 1, now });
    for (let n = 0; n < 5; n++) log.log(event(n));
    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([2, 3, 4]);
    clock += 2 * 86_400_000;
    log.log(event(9));
    expect((await log.entries()).map((e) => e.fields["N"])).toEqual([9]);
    expect((await indexedDB.databases()).length).toBe(0);
  });

  it("clear empties the log", async () => {
    const log = new BrowserLog({ now });
    log.log(event(1));
    await log.flush();
    log.log(event(2));
    await log.clear();
    expect(await log.entries()).toEqual([]);
  });

  describe("in an agent", () => {
    const users = [{ email: "anna@example.com", password: "secret" }];
    const gateway = () => new FakeGateway({ users, principal: true, model: () => ({ text: "Done." }), agents: [{ slug: "docs" }] });

    async function agent(gw: FakeGateway, configure: (b: ReturnType<typeof FadenstackAgent.createBuilder>) => void): Promise<FadenstackAgent> {
      const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gw.serverUrl, agent: "docs", fetch: gw.fetch });
      await tokens.signIn(await loginWithPassword({ apiUrl: gw.serverUrl, email: "anna@example.com", password: "secret", fetch: gw.fetch }));
      const builder = FadenstackAgent.createBuilder().useClient(client).useApprovals(() => Promise.resolve(ApprovalDecision.approve()));
      configure(builder);
      return builder.build();
    }

    it("logs the agent's and the client's entries beside the host's own logger, in the person's database", async () => {
      const seen: LogEvent[] = [];
      let browser: BrowserLog | undefined;
      const a = await agent(gateway(), (b) => { b.useLogging({ log: (e) => seen.push(e) }).useBrowserLog({ now, minLevel: "debug" }); browser = b.browserLog; });
      const session = await a.startSession("ask");
      await session.send("hello");
      await a.flush();
      await browser!.flush();

      const entries = await browser!.entries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.map((e) => e.category)).toContain("Fadenstack.Agents");
      expect(entries.map((e) => e.category)).toContain("Fadenstack.Client");
      // Both got every entry from the moment the person was known; the earlier ones are in the database without a person.
      expect(entries.length).toBeLessThan(seen.length);
      expect(entries.map(({ at: _at, ...rest }) => rest)).toEqual(seen.slice(seen.length - entries.length));
      expect(seen.length - entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(entries)).not.toContain("hello"); // content-free
      expect((await indexedDB.databases()).map((d) => d.name)).toContain(userStoreName(BROWSER_LOG_DATABASE, PERSON));
    });

    it("\"Remove my data\" (all of it) deletes the person's log and the one kept before sign-in", async () => {
      let browser: BrowserLog | undefined;
      const a = await agent(gateway(), (b) => { b.useBrowserLog({ now }); browser = b.browserLog; });
      browser!.log(event(1)); // before the person is known: the database without a person
      await browser!.flush();
      await (await a.startSession("ask")).send("hello");
      await a.flush();
      await browser!.flush();
      const names = async () => (await indexedDB.databases()).map((d) => d.name);
      expect(await names()).toEqual(expect.arrayContaining([BROWSER_LOG_DATABASE, userStoreName(BROWSER_LOG_DATABASE, PERSON)]));

      const deletion = await a.deleteMyData({ scope: "allApps" });

      expect(deletion.scope).toBe("allApps");
      expect(await names()).toEqual([]);
      expect(await browser!.entries()).toEqual([]);
    });

    it("\"Remove my data\" for this app, with no other app using the data, takes the person's log too", async () => {
      let browser: BrowserLog | undefined;
      const a = await agent(gateway(), (b) => { b.useBrowserLog({ now }); browser = b.browserLog; });
      await (await a.startSession("ask")).send("hello");
      await a.flush();
      await browser!.flush();
      expect(await indexedDB.databases().then((d) => d.map((x) => x.name))).toContain(userStoreName(BROWSER_LOG_DATABASE, PERSON));

      await a.deleteMyData();

      // the log kept before anybody signed in has no person: only "all of my data" takes it
      expect((await indexedDB.databases()).map((d) => d.name)).toEqual([BROWSER_LOG_DATABASE]);
    });

    it("the export lists the log's entries and holds only the stored fields", async () => {
      let browser: BrowserLog | undefined;
      const a = await agent(gateway(), (b) => { b.useBrowserLog({ now }); browser = b.browserLog; });
      await (await a.startSession("ask")).send("hello");
      await a.flush();
      await browser!.flush();

      const exported = await a.exportMyData({ scope: "allApps" });
      const rows = exported.databases?.["log"]?.["entries"] ?? [];

      expect(rows.length).toBeGreaterThan(0);
      for (const { value: row } of rows as unknown as { value: StoredLogEntry }[]) expect(Object.keys(row).filter((k) => !["category", "eventId", "eventName", "level", "message", "fields", "scope", "at"].includes(k))).toEqual([]);
    });
  });
});
