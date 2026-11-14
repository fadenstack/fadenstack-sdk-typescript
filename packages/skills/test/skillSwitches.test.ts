import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { IndexedDbSkillStore, IndexedDbSkillSwitches, MemorySkillStore, MemorySkillSwitches, openSkillSwitches, skillsModule } from "@fadenstack/skills";

import { ask, calls, standalone, standard } from "./rig.js";
import { BUNDLED_SLIDE_DESIGN } from "./workshopRig.js";

/** The person's on/off switch per skill: in memory, in IndexedDB per principal, and honoured by the module. */
const instructionsOf = (rig: ReturnType<typeof standalone>, index = 0) => calls(rig.fake)[index]!.instructions!;

describe("the switches in memory", () => {
  it("keep a skill on until it is switched off, and say whether a switch changed anything", async () => {
    const switches = new MemorySkillSwitches();

    expect(await switches.isEnabled("a-skill")).toBe(true);
    expect(await switches.set("a-skill", false)).toBe(true);
    expect(await switches.set("a-skill", false)).toBe(false);
    expect(await switches.isEnabled("a-skill")).toBe(false);
    expect([...(await switches.disabled())]).toEqual(["a-skill"]);
    expect(await switches.set("a-skill", true)).toBe(true);
    expect(await switches.set("a-skill", true)).toBe(false);
    expect((await switches.disabled()).size).toBe(0);
  });
});

describe("the switches in IndexedDB", () => {
  it("work again after the person's data was deleted while they were open", async () => {
    const factory = new IDBFactory();
    const switches = new IndexedDbSkillSwitches({ indexedDB: factory });
    await switches.set("a-skill", false);
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase("fadenstack-skill-switches:standalone:standalone");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error("blocked"));
    });

    expect(await switches.isEnabled("a-skill")).toBe(true);
    expect(await switches.set("a-skill", false)).toBe(true);
    switches.close();
  });

  it("are kept, and survive a new instance on the same database", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbSkillSwitches({ indexedDB: factory });
    expect(await first.isEnabled("a-skill")).toBe(true);
    expect(await first.set("a-skill", false)).toBe(true);
    expect(await first.set("a-skill", false)).toBe(false);
    first.close();

    const second = new IndexedDbSkillSwitches({ indexedDB: factory });

    expect(await second.isEnabled("a-skill")).toBe(false);
    expect(await second.isEnabled("another")).toBe(true);
    expect([...(await second.disabled())]).toEqual(["a-skill"]);
    expect(await second.set("a-skill", true)).toBe(true);
    expect(await new IndexedDbSkillSwitches({ indexedDB: factory }).isEnabled("a-skill")).toBe(true);
    second.close();
  });

  it("are kept per principal: two people in one browser profile do not see each other's", async () => {
    const factory = new IDBFactory();
    const standaloneSwitches = new IndexedDbSkillSwitches({ indexedDB: factory });
    const ana = new IndexedDbSkillSwitches({ indexedDB: factory, principal: { tenantId: "t 1", userId: "ana/1" } });
    const ben = new IndexedDbSkillSwitches({ indexedDB: factory, principal: { tenantId: "t 1", userId: "ben" } });

    expect(standaloneSwitches.databaseName).toBe("fadenstack-skill-switches:standalone:standalone");
    expect(ana.databaseName).toBe("fadenstack-skill-switches:t%201:ana%2F1");
    await ana.set("shared-name", false);
    await ben.set("ben-only", false);

    expect([...(await ana.disabled())]).toEqual(["shared-name"]);
    expect([...(await ben.disabled())]).toEqual(["ben-only"]);
    expect(await ben.isEnabled("shared-name")).toBe(true);
    expect((await standaloneSwitches.disabled()).size).toBe(0);
    for (const s of [standaloneSwitches, ana, ben]) s.close();
  });

  it("follow a principal given as a function, and open the other person's database when it changes", async () => {
    const factory = new IDBFactory();
    let principal: { tenantId: string; userId: string } | undefined = { tenantId: "t", userId: "one" };
    const switches = new IndexedDbSkillSwitches({ indexedDB: factory, principal: () => principal });

    await switches.set("a-skill", false);
    principal = { tenantId: "t", userId: "two" };
    expect(await switches.isEnabled("a-skill")).toBe(true);
    principal = { tenantId: "t", userId: "one" };
    expect(await switches.isEnabled("a-skill")).toBe(false);
    principal = undefined; // a server that names no user: the shared database
    expect(switches.databaseName).toBe("fadenstack-skill-switches");
    expect(await switches.isEnabled("a-skill")).toBe(true);
    switches.close();
  });

  it("see a change made through another connection to the same database", async () => {
    const factory = new IDBFactory();
    const here = new IndexedDbSkillSwitches({ indexedDB: factory });
    const there = new IndexedDbSkillSwitches({ indexedDB: factory });

    await there.set("a-skill", false);

    expect(await here.isEnabled("a-skill")).toBe(false);
    here.close();
    there.close();
  });

  it("are picked by openSkillSwitches where there is an IndexedDB, and memory where there is not", () => {
    expect(openSkillSwitches({ indexedDB: new IDBFactory() })).toBeInstanceOf(IndexedDbSkillSwitches);
    // the test runner has no global IndexedDB: memory
    expect(globalThis.indexedDB).toBeUndefined();
    expect(openSkillSwitches()).toBeInstanceOf(MemorySkillSwitches);
  });
});

describe("the module honours an off switch", () => {
  it("does not list an off own skill nor an off bundled skill", async () => {
    const store = new MemorySkillStore();
    await store.add(standard("house-style"));
    await store.add(standard("nda-review", "Reviews NDAs."));
    const switches = new MemorySkillSwitches();
    const rig = standalone({ module: skillsModule({ store, switches, bundled: [BUNDLED_SLIDE_DESIGN] }) });

    await ask(rig, "First slide.");
    await switches.set("house-style", false);
    await switches.set("slide-design", false);
    await ask(rig, "Second slide.");
    await switches.set("house-style", true);
    await ask(rig, "Third slide.");

    expect(instructionsOf(rig, 0)).toContain("<name>house-style</name>");
    expect(instructionsOf(rig, 0)).toContain("<name>slide-design</name>");
    expect(instructionsOf(rig, 1)).not.toContain("house-style");
    expect(instructionsOf(rig, 1)).not.toContain("slide-design");
    expect(instructionsOf(rig, 1)).toContain("<name>nda-review</name>");
    expect(instructionsOf(rig, 2)).toContain("<name>house-style</name>");
    expect(instructionsOf(rig, 2)).not.toContain("slide-design");
  });

  it("does not let a skill of the person's take the name of an off bundled skill meanwhile", async () => {
    const store = new MemorySkillStore();
    await store.add({ name: "slide-design", description: "Mine, with a bundled name.", body: "Mine." });
    const switches = new MemorySkillSwitches();
    await switches.set("slide-design", false);
    const rig = standalone({ module: skillsModule({ store, switches, bundled: [BUNDLED_SLIDE_DESIGN] }) });

    await ask(rig, "hello");

    expect(instructionsOf(rig)).not.toContain("slide-design");
  });

  it("reads switches kept in IndexedDB the same way", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbSkillStore({ indexedDB: factory });
    await store.add(standard("house-style"));
    const switches = new IndexedDbSkillSwitches({ indexedDB: factory });
    await switches.set("house-style", false);
    await switches.set("slide-design", false);
    const rig = standalone({ module: skillsModule({ store, switches, bundled: [BUNDLED_SLIDE_DESIGN, { name: "other-bundled", description: "Another.", body: "B" }] }) });

    await ask(rig, "A slide, please.");

    expect(instructionsOf(rig)).toContain("<name>other-bundled</name>");
    expect(instructionsOf(rig)).not.toContain("house-style");
    expect(instructionsOf(rig)).not.toContain("slide-design");
    store.close();
    switches.close();
  });

  it("keeps its default switches in the person's IndexedDB, where the workshop sets them", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory, bundled: [BUNDLED_SLIDE_DESIGN] });
    expect(module.switches).toBeInstanceOf(IndexedDbSkillSwitches);
    expect((module.switches as IndexedDbSkillSwitches).databaseName).toBe("fadenstack-skill-switches:standalone:standalone");

    await module.workshop().setEnabled("slide-design", false);
    const rig = standalone({ module });
    await ask(rig, "A slide, please.");

    expect(calls(rig.fake)[0]!.instructions).not.toContain("slide-design");
    expect([...(await new IndexedDbSkillSwitches({ indexedDB: factory }).disabled())]).toEqual(["slide-design"]);
  });

  it("lists every skill when the app keeps no switches", async () => {
    const module = skillsModule({ store: false, switches: false, bundled: [BUNDLED_SLIDE_DESIGN] });
    const rig = standalone({ module });

    await ask(rig, "A slide, please.");

    expect(module.switches).toBeUndefined();
    expect(instructionsOf(rig)).toContain("slide-design");
  });
});
