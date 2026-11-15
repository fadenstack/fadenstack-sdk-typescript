import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { IndexedDbSkillStore, MemorySkillStore, SkillRuleError, openSkillStore, skillsModule } from "@fadenstack/skills";

import { ask, calls, standalone, standard } from "./rig.js";

describe("the person's own skills in IndexedDB", () => {
  it("adds, lists and removes a skill, by name", async () => {
    const store = new IndexedDbSkillStore({ indexedDB: new IDBFactory() });

    await store.add(standard("zeta-skill"));
    await store.add(standard("alpha-skill", "Alpha."));
    await store.add(standard("alpha-skill", "Alpha again.")); // the same name replaces

    expect((await store.list()).map((s) => s.name)).toEqual(["alpha-skill", "zeta-skill"]);
    expect((await store.get("alpha-skill"))?.description).toBe("Alpha again.");
    expect(await store.get("nothing")).toBeUndefined();
    expect(await store.remove("zeta-skill")).toBe(true);
    expect(await store.remove("zeta-skill")).toBe(false);
    expect((await store.list()).map((s) => s.name)).toEqual(["alpha-skill"]);
    store.close();
  });

  it("works again after the person's data was deleted while it was open", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbSkillStore({ indexedDB: factory });
    await store.add(standard());
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase("fadenstack-skills:standalone:standalone");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error("blocked"));
    });

    expect(await store.list()).toEqual([]);
    await store.add(standard());
    expect((await store.list()).map((s) => s.name)).toEqual(["house-style"]);
    store.close();
  });

  it("keeps the skills for the next time the database is opened", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbSkillStore({ indexedDB: factory });
    await first.add(standard());
    first.close();

    const second = new IndexedDbSkillStore({ indexedDB: factory });

    expect((await second.list()).map((s) => s.name)).toEqual(["house-style"]);
    expect((await second.get("house-style"))?.resources).toEqual({ "references/tone.md": expect.any(String) });
    second.close();
  });

  it("keeps a database per principal, and standalone is its own principal", async () => {
    const factory = new IDBFactory();
    const standaloneStore = new IndexedDbSkillStore({ indexedDB: factory });
    const ana = new IndexedDbSkillStore({ indexedDB: factory, principal: { tenantId: "t 1", userId: "ana/1" } });
    const ben = new IndexedDbSkillStore({ indexedDB: factory, principal: { tenantId: "t 1", userId: "ben" } });
    const shared = new IndexedDbSkillStore({ indexedDB: factory, principal: undefined }); // no principal given: the standalone one

    expect(standaloneStore.databaseName).toBe("fadenstack-skills:standalone:standalone");
    expect(ana.databaseName).toBe("fadenstack-skills:t%201:ana%2F1");
    expect(ben.databaseName).not.toBe(ana.databaseName);
    await ana.add(standard("ana-skill"));
    await ben.add(standard("ben-skill"));

    expect((await ana.list()).map((s) => s.name)).toEqual(["ana-skill"]);
    expect((await ben.list()).map((s) => s.name)).toEqual(["ben-skill"]);
    expect(await standaloneStore.list()).toEqual([]);
    expect(shared.databaseName).toBe("fadenstack-skills:standalone:standalone");
    for (const store of [standaloneStore, ana, ben, shared]) store.close();
  });

  it("follows a principal that is given as a function, and opens the other database when it changes", async () => {
    const factory = new IDBFactory();
    let principal: { tenantId: string; userId: string } | undefined = { tenantId: "t", userId: "one" };
    const store = new IndexedDbSkillStore({ indexedDB: factory, principal: () => principal });
    await store.add(standard("one-skill"));

    principal = undefined; // a server that names no user: the shared database
    expect(store.databaseName).toBe("fadenstack-skills");
    expect(await store.list()).toEqual([]);
    principal = { tenantId: "t", userId: "one" };

    expect((await store.list()).map((s) => s.name)).toEqual(["one-skill"]);
    store.close();
  });

  it("refuses a skill that breaks the six-field rule, and keeps nothing of it", async () => {
    const store = new IndexedDbSkillStore({ indexedDB: new IDBFactory() });

    await expect(store.add({ ...standard(), extra: 1 } as never)).rejects.toBeInstanceOf(SkillRuleError);
    await expect(store.add(standard("Bad_Name"))).rejects.toThrow(/lowercase letters/);
    await expect(store.add(standard("long", "x".repeat(1025)))).rejects.toThrow(/1,024/);
    await expect(store.add(null as never)).rejects.toBeInstanceOf(SkillRuleError);

    expect(await store.list()).toEqual([]);
    store.close();
  });

  it("tells the listeners about a change, and not about a removal of nothing", async () => {
    const store = new IndexedDbSkillStore({ indexedDB: new IDBFactory() });
    let changes = 0;
    const stop = store.onChanged(() => changes++);

    await store.add(standard());
    await store.remove("nothing");
    await store.remove("house-style");
    stop();
    await store.add(standard());

    expect(changes).toBe(2);
    store.close();
  });

  it("gives a skill back as it was stored, not as the same object", async () => {
    const store = new MemorySkillStore();
    const skill = standard();
    await store.add(skill);
    skill.description = "Changed after.";

    expect((await store.get("house-style"))?.description).toBe("Writes customer replies in the house style.");
  });

  it("opens in memory where there is no IndexedDB", async () => {
    const saved = globalThis.indexedDB;
    try {
      // @ts-expect-error a runtime without IndexedDB
      globalThis.indexedDB = undefined;
      const store = openSkillStore();
      expect(store).toBeInstanceOf(MemorySkillStore);
      await store.add(standard());
      expect((await store.list()).map((s) => s.name)).toEqual(["house-style"]);
      expect(() => new IndexedDbSkillStore()).toThrow(/no IndexedDB/);
    } finally {
      globalThis.indexedDB = saved;
    }
  });

  it("is the module's default store, in the standalone principal's database", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory });
    const rig = standalone({ module });
    await ask(rig, "Hello"); // the agent starts: the module learns the person (standalone) from the profile
    await module.store!.add(standard("kept-on-device"));

    await ask(rig, "Hi");

    expect(calls(rig.fake).at(-1)!.instructions).toContain("kept-on-device");
    const names = await new Promise<string[]>((resolve) => {
      void (factory as IDBFactory & { databases(): Promise<{ name?: string }[]> }).databases().then((all) => resolve(all.map((d) => d.name ?? "")));
    });
    expect(names.sort()).toEqual(["fadenstack-skill-switches:standalone:standalone", "fadenstack-skills:standalone:standalone"]); // the skills and the person's switches
    module.store!.close();
  });
});
