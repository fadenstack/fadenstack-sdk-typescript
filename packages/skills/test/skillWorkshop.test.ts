import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { SkillIssueCode, SkillOrigin, SkillSaveStatus } from "@fadenstack/agents";
import type { SkillOption } from "@fadenstack/client";
import { IndexedDbSkillStore, MemorySkillStore, StoreSkillWorkshop, skillsModule } from "@fadenstack/skills";

import { ask, calls, standalone } from "./rig.js";
import { FailingStore, RawSkillStore, binaryFile, doc, fields, textFile, workshopRig } from "./workshopRig.js";

/** The skill store: save as one record, rename, delete, the sources and the on/off switch (sdk/51 F04). Port of the .NET `SkillWorkshopTests`. */
const orgSkill = (slug: string): SkillOption => ({ id: "1", slug, name: "Org policy", description: "From the server.", activation: "auto" });
const names = async (rig: { store: { list(): Promise<{ name: string }[]> } }) => (await rig.store.list()).map((s) => s.name);

describe("saving a skill", () => {
  it("is read back whole", async () => {
    const rig = workshopRig();
    const document = doc("contract-review", undefined, {
      license: "Apache-2.0",
      compatibility: "any agent",
      metadata: { author: "tests" },
      allowedTools: "read_page",
      extension: fields({ keywords: ["contract", "clause"], preferredTools: ["read_page"], priority: 70, activation: "always" }),
      resources: [textFile("references/tone.md", "Warm."), textFile("assets/notes.txt", "Notes.")],
    });

    const saved = await rig.workshop.save(document);
    const read = await rig.workshop.read("contract-review");

    expect(saved.status).toBe(SkillSaveStatus.Saved);
    expect(saved.saved).toBe(true);
    expect(read.origin).toBe(SkillOrigin.Own);
    const back = read.document!;
    expect([back.name, back.description, back.license, back.compatibility, back.allowedTools]).toEqual([
      "contract-review",
      "Reviews a contract clause by clause.",
      "Apache-2.0",
      "any agent",
      "read_page",
    ]);
    expect(back.metadata["author"]).toBe("tests");
    expect(back.instructions.trim()).toBe(document.instructions.trim());
    expect(back.extension.keywords).toEqual(["contract", "clause"]);
    expect([back.extension.activation, back.extension.priority]).toEqual(["always", 70]);
    expect(back.extension.preferredTools).toEqual(["read_page"]);
    expect(back.resources.map((r) => r.path).sort()).toEqual(["assets/notes.txt", "references/tone.md"]);
    expect(read.issues.filter((i) => i.isError)).toEqual([]);
    expect(await names(rig)).toEqual(["contract-review"]);
  });

  it("keeps only the six standard fields in the record, and the extras in the faden.yaml text", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc("contract-review", undefined, { extension: fields({ keywords: ["clause"], title: "Contract review" }) }));

    const record = (await rig.store.get("contract-review"))!;

    expect(Object.keys(record).sort()).toEqual(["body", "description", "fadenYaml", "name"]);
    expect(record.body).not.toContain("keywords");
    expect(record.fadenYaml).toContain("keywords:");
    expect(record.fadenYaml).toContain("title: Contract review");
  });

  it("is refused when the checks find an error, and writes nothing", async () => {
    const rig = workshopRig();

    const result = await rig.workshop.save(doc("contract-review", ""));

    expect(result.status).toBe(SkillSaveStatus.Refused);
    expect(result.issues.some((i) => i.code === SkillIssueCode.DescriptionMissing)).toBe(true);
    expect(await rig.store.list()).toEqual([]);
    expect(rig.changes.count).toBe(0);
  });

  it("refuses a resource that is not text with BinaryFile, and writes nothing", async () => {
    const rig = workshopRig();

    const result = await rig.workshop.save(doc("contract-review", undefined, { resources: [binaryFile("assets/pic.bin", [1, 2, 3, 0, 255])] }));

    expect(result.status).toBe(SkillSaveStatus.Refused);
    expect(result.issues.some((i) => i.code === SkillIssueCode.BinaryFile)).toBe(true);
    expect(await rig.store.list()).toEqual([]);
  });

  it.each(["../evil", "..\\evil", "a/b", "C:evil", ".hidden"])("never takes a name that is a path: %j", async (name) => {
    const rig = workshopRig();

    const result = await rig.workshop.save(doc(name));
    const deleted = await rig.workshop.delete(name);
    const read = await rig.workshop.read(name);

    expect(result.status).toBe(SkillSaveStatus.Refused);
    expect(deleted).toBe(false);
    expect(read.document).toBeUndefined();
    expect(read.issues.some((i) => i.code === SkillIssueCode.ReadFailed)).toBe(true);
    expect(await rig.store.list()).toEqual([]);
  });

  it("asks before a second skill of the same name, and replaces it whole only when confirmed", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc("contract-review", undefined, { resources: [textFile("old.md", "Old.")] }));

    const asked = await rig.workshop.save(doc("contract-review", "New one."));

    expect(asked.status).toBe(SkillSaveStatus.Exists);
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("Reviews a contract clause by clause.");
    expect((await rig.store.get("contract-review"))?.resources).toEqual({ "old.md": "Old." });

    const confirmed = await rig.workshop.save(doc("contract-review", "New one."), undefined, true);

    expect(confirmed.status).toBe(SkillSaveStatus.Saved);
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("New one.");
    expect((await rig.store.get("contract-review"))?.resources).toBeUndefined(); // nothing of the old one is left
  });

  it("needs no confirmation for an edit of the same skill", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc());

    const result = await rig.workshop.save(doc("contract-review", "Edited."), "contract-review");

    expect(result.status).toBe(SkillSaveStatus.Saved);
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("Edited.");
  });

  it("moves the skill and its switch on a rename, and leaves no old record", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc());
    await rig.workshop.setEnabled("contract-review", false);
    const before = rig.changes.count;

    const result = await rig.workshop.save(doc("nda-review"), "contract-review");

    expect(result.status).toBe(SkillSaveStatus.Saved);
    expect(await names(rig)).toEqual(["nda-review"]);
    const entries = await rig.workshop.list();
    expect(entries.filter((e) => e.origin === SkillOrigin.Own).map((e) => e.name)).toEqual(["nda-review"]);
    expect(entries.find((e) => e.name === "nda-review")!.enabled).toBe(false);
    expect(await rig.switches.isEnabled("contract-review")).toBe(true);
    expect(rig.changes.count).toBeGreaterThan(before);
  });

  it("removes the old record in the same step as it writes the new one (IndexedDB)", async () => {
    const store = new IndexedDbSkillStore({ indexedDB: new IDBFactory() });
    const rig = workshopRig({ store });
    await rig.workshop.save(doc());

    await rig.workshop.save(doc("nda-review"), "contract-review");

    expect(await names(rig)).toEqual(["nda-review"]);
    store.close();
  });

  it("renames in a store that has no save of its own, by an add and a remove", async () => {
    const store = new RawSkillStore();
    const rig = workshopRig({ store });
    await rig.workshop.save(doc());

    const result = await rig.workshop.save(doc("nda-review"), "contract-review");

    expect(result.status).toBe(SkillSaveStatus.Saved);
    expect([...store.records.keys()]).toEqual(["nda-review"]);
  });

  it("asks first on a rename onto another skill, and changes nothing", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc());
    await rig.workshop.save(doc("nda-review", "Reviews NDAs."));
    const before = rig.changes.count;

    const result = await rig.workshop.save(doc("nda-review"), "contract-review");

    expect(result.status).toBe(SkillSaveStatus.Exists);
    expect(await names(rig)).toEqual(["contract-review", "nda-review"]);
    expect((await rig.workshop.read("nda-review")).document!.description).toBe("Reviews NDAs.");
    expect(rig.changes.count).toBe(before);
  });

  it("leaves everything as it was when the write fails", async () => {
    const memory = workshopRig({ store: new FailingStore() });
    const raw = new RawSkillStore();
    raw.records.set("contract-review", { name: "contract-review", description: "Kept.", body: "Body" });
    const rig = workshopRig({ store: raw });
    raw.failWrites = true;

    const first = await memory.workshop.save(doc());
    const second = await rig.workshop.save(doc("nda-review"), "contract-review");
    const third = await rig.workshop.save(doc("contract-review", "Lost."), "contract-review");

    expect([first.status, second.status, third.status]).toEqual([SkillSaveStatus.Failed, SkillSaveStatus.Failed, SkillSaveStatus.Failed]);
    expect(await memory.store.list()).toEqual([]);
    expect([...raw.records.keys()]).toEqual(["contract-review"]);
    expect((await raw.get("contract-review"))?.description).toBe("Kept.");
    expect(memory.changes.count + rig.changes.count).toBe(0);
  });

  it("is not allowed without a store", async () => {
    const workshop = new StoreSkillWorkshop({ store: undefined });

    const result = await workshop.save(doc());

    expect(result.status).toBe(SkillSaveStatus.NotAllowed);
    expect((await workshop.list()).map((e) => e.origin)).toEqual([]);
  });
});

describe("deleting a skill", () => {
  it("removes an own skill only", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc());

    expect(await rig.workshop.delete("slide-design")).toBe(false); // bundled
    expect(await rig.workshop.delete("not-there")).toBe(false);
    expect(await rig.workshop.delete("contract-review")).toBe(true);

    expect(await rig.store.list()).toEqual([]);
    expect((await rig.workshop.list()).some((e) => e.name === "contract-review")).toBe(false);
  });

  it("takes the skill's switch with it", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc());
    await rig.workshop.setEnabled("contract-review", false);

    await rig.workshop.delete("contract-review");

    expect(await rig.switches.isEnabled("contract-review")).toBe(true);
  });
});

describe("the library", () => {
  it("lists bundled, own and organisation skills with their sources", async () => {
    const rig = workshopRig({ organisation: async () => [orgSkill("org-policy")] });
    await rig.workshop.save(doc());

    const entries = await rig.workshop.list();

    expect(entries.map((e) => e.origin)).toEqual([SkillOrigin.Bundled, SkillOrigin.Own, SkillOrigin.Organisation]);
    const [bundled, own, org] = entries;
    expect([bundled!.isReadOnly, bundled!.canSwitch, bundled!.notReviewed]).toEqual([true, true, false]);
    expect([own!.isReadOnly, own!.canSwitch, own!.notReviewed]).toEqual([false, true, true]);
    expect([org!.isReadOnly, org!.canSwitch, org!.notReviewed]).toEqual([true, false, false]);
    expect(org!.name).toBe("org-policy");
    expect(entries.every((e) => e.enabled)).toBe(true);
  });

  it("keeps the rest of the library when the organisation's list fails", async () => {
    const rig = workshopRig({ organisation: async () => Promise.reject(new Error("offline")) });
    await rig.workshop.save(doc());

    expect(await rig.workshop.list()).toHaveLength(2);
  });

  it("reads a bundled skill, never writes it, and does not let its name be taken", async () => {
    const rig = workshopRig();

    const read = await rig.workshop.read("slide-design");
    const save = await rig.workshop.save(doc("slide-design"));
    const edit = await rig.workshop.save(doc("slide-design-2"), "slide-design");

    expect(read.origin).toBe(SkillOrigin.Bundled);
    expect(read.document!.instructions).toBe("Use one idea per slide.");
    expect(read.document!.extension.keywords).toContain("slide");
    expect(read.document!.resources.map((r) => [r.path, new TextDecoder().decode(r.bytes)])).toEqual([["layouts", "Title, then two columns."]]);
    expect(save.status).toBe(SkillSaveStatus.Refused);
    expect(save.issues.some((i) => i.code === SkillIssueCode.NameReserved)).toBe(true);
    expect(edit.status).toBe(SkillSaveStatus.NotAllowed);
    expect(await rig.store.list()).toEqual([]);
  });

  it("lists a record that breaks a rule as broken, shows its problem, and still lets it be deleted", async () => {
    const store = new RawSkillStore();
    store.records.set("odd-one", { name: "odd-one", description: "", body: "x" });
    store.records.set("extra-key", { name: "extra-key", description: "x", body: "Body", version: 2 });
    store.records.set("fine-one", { name: "fine-one", description: "x", body: "Body" });
    const rig = workshopRig({ store });

    const entries = (await rig.workshop.list()).filter((e) => e.origin === SkillOrigin.Own);
    const read = await rig.workshop.read("extra-key");

    expect(entries.map((e) => [e.name, e.isBroken])).toEqual([["extra-key", true], ["fine-one", false], ["odd-one", true]]);
    expect(read.issues.some((i) => i.code === SkillIssueCode.UnknownKey && i.detail === "version")).toBe(true);
    expect(await rig.workshop.delete("odd-one")).toBe(true);
    expect([...store.records.keys()].sort()).toEqual(["extra-key", "fine-one"]);
  });

  it("does not list a record that breaks a rule for the model", async () => {
    const store = new RawSkillStore();
    store.records.set("extra-key", { name: "extra-key", description: "x", body: "Body", version: 2 });
    store.records.set("fine-one", { name: "fine-one", description: "x", body: "Body" });
    const rig = standalone({ module: skillsModule({ store, switches: false }) });

    await ask(rig, "hello");

    expect(calls(rig.fake)[0]!.instructions).toContain("<name>fine-one</name>");
    expect(calls(rig.fake)[0]!.instructions).not.toContain("extra-key");
  });

  it("takes a stored record under a bundled name as broken", async () => {
    const store = new RawSkillStore();
    store.records.set("slide-design", { name: "slide-design", description: "Mine.", body: "Body" });
    const rig = workshopRig({ store });

    const own = (await rig.workshop.list()).filter((e) => e.origin === SkillOrigin.Own);

    expect(own.map((e) => [e.name, e.isBroken])).toEqual([["slide-design", true]]);
  });
});

describe("the switch", () => {
  it("is kept per skill and the module does not list an off skill for the model", async () => {
    const store = new MemorySkillStore();
    const rig = workshopRig({ store });
    await rig.workshop.save(doc());
    await rig.workshop.save(doc("nda-review", "Reviews NDAs."));
    const agent = standalone({ module: rig.module });

    await ask(agent, "First slide.");
    await rig.workshop.setEnabled("contract-review", false);
    await rig.workshop.setEnabled("slide-design", false);
    await ask(agent, "Second slide.");
    await rig.workshop.setEnabled("contract-review", true);
    await ask(agent, "Third slide.");

    const all = calls(agent.fake);
    expect(all[0]!.instructions).toContain("<name>contract-review</name>");
    expect(all[0]!.instructions).toContain("<name>slide-design</name>");
    expect(all[1]!.instructions).not.toContain("contract-review");
    expect(all[1]!.instructions).not.toContain("slide-design");
    expect(all[1]!.instructions).toContain("<name>nda-review</name>");
    expect(all[2]!.instructions).toContain("<name>contract-review</name>");
  });

  it("refuses to switch a skill that is not there, and switches a bundled one", async () => {
    const rig = workshopRig();

    await rig.workshop.setEnabled("not-there", false);
    await rig.workshop.setEnabled("../evil", false);
    await rig.workshop.setEnabled("slide-design", false);

    expect([...(await rig.switches.disabled())]).toEqual(["slide-design"]);
    expect((await rig.workshop.list()).find((e) => e.name === "slide-design")!.enabled).toBe(false);
  });

  it("makes the workshop refresh the module after a switch, a save and a delete, and not after a switch that changes nothing", async () => {
    const module = skillsModule({ store: false, switches: false });
    let refreshed = 0;
    module.onChanged(() => refreshed++);
    const store = new MemorySkillStore();
    const workshop = new StoreSkillWorkshop({ store, changed: () => module.refresh() });

    await workshop.save(doc());
    await workshop.setEnabled("contract-review", false);
    await workshop.setEnabled("contract-review", false); // no change
    await workshop.delete("contract-review");

    expect(refreshed).toBe(3);
  });

  it("tells the module through its own workshop when the store changes", async () => {
    const rig = workshopRig();

    await rig.workshop.save(doc());

    expect(rig.changes.count).toBeGreaterThan(0);
  });
});

describe("commitImport", () => {
  it("writes what passes the checks now, whatever the analysis claims", async () => {
    const rig = workshopRig();
    const analysis = {
      source: "x.zip",
      document: doc("slide-design"),
      issues: [],
      wouldReplace: false,
      fileCount: 1,
      totalBytes: 1,
      ok: true,
    };

    const result = await rig.workshop.commitImport(analysis, true);

    expect(result.status).toBe(SkillSaveStatus.Refused);
    expect(await rig.store.list()).toEqual([]);
  });

  it("refuses an analysis without a document", async () => {
    const rig = workshopRig();

    const result = await rig.workshop.commitImport({ source: "x.zip", document: undefined, issues: [], wouldReplace: false, fileCount: 0, totalBytes: 0, ok: false }, true);

    expect(result.status).toBe(SkillSaveStatus.Refused);
  });
});
