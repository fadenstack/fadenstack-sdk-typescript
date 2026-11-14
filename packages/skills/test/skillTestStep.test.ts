import { describe, expect, it } from "vitest";

import type { SkillDocument } from "@fadenstack/agents";

import { doc, fields, workshopRig } from "./workshopRig.js";

/** The editor's Test step: the module's own pre-selection over the edited skill and the person's others. Port of the .NET `SkillTestStepTests`. */
const keyed = (name = "contract-review", ...keywords: string[]): SkillDocument => doc(name, undefined, { extension: fields({ keywords }) });

describe("the test step", () => {
  it("lists a keyword match and pre-loads the edited skill", async () => {
    const { workshop } = workshopRig();

    const result = await workshop.test("Please review this clause.", keyed("contract-review", "clause"));

    expect(result.listed).toContain("contract-review");
    expect(result.matches).toEqual([{ name: "contract-review", matchedBy: "trigger", score: 80 }]);
    expect(result.preloaded).toEqual(["contract-review"]);
    expect(result.editedListed).toBe(true);
    expect(result.modelInstructions).toContain("contract-review");
    expect(result.listed).not.toContain("slide-design");
  });

  it("picks a skill the prompt names as explicit, whatever its activation", async () => {
    const { workshop } = workshopRig();
    const manual = doc("contract-review", undefined, { extension: fields({ keywords: ["clause"], activation: "manual" }) });

    const result = await workshop.test("Use $contract-review here.", manual);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.matchedBy).toBe("explicit");
    expect(result.preloaded).toEqual(["contract-review"]);
  });

  it("lists a skill without a faden.yaml for the model, but never pre-loads it", async () => {
    const { workshop } = workshopRig();

    const result = await workshop.test("Anything at all.", doc());

    expect(result.listed).toEqual(["contract-review"]);
    expect(result.matches).toEqual([]);
    expect(result.preloaded).toEqual([]);
    expect(result.editedListed).toBe(true);
  });

  it("does not offer a skill the prompt does not match, and says so", async () => {
    const { workshop } = workshopRig();

    const result = await workshop.test("Something about cooking.", keyed("contract-review", "clause"));

    expect(result.editedListed).toBe(false);
    expect(result.listed).not.toContain("contract-review");
    expect(result.modelInstructions).toBeUndefined();
  });

  it("lets the edited skill stand in for the saved one it came from, and for its old name", async () => {
    const { workshop } = workshopRig();
    await workshop.save(doc("contract-review", "The saved description."));

    const edited = await workshop.test("hello", doc("contract-review", "The edited description."));
    const renamed = await workshop.test("hello", doc("nda-review"), "contract-review");

    expect(edited.modelInstructions).toContain("The edited description.");
    expect(edited.modelInstructions).not.toContain("The saved description.");
    expect(renamed.listed).toEqual(["nda-review"]);
  });

  it("does not offer an off skill, but the one being edited is always offered", async () => {
    const { workshop } = workshopRig();
    await workshop.save(doc("contract-review"));
    await workshop.save(doc("nda-review", "Reviews NDAs."));
    await workshop.setEnabled("nda-review", false);
    await workshop.setEnabled("slide-design", false);

    const others = await workshop.test("Make a slide deck.", undefined);
    const editing = await workshop.test("Make a slide deck.", doc("nda-review", "Reviews NDAs."));

    expect(others.listed).toEqual(["contract-review"]);
    expect(others.matches).toEqual([]);
    expect(editing.listed).toContain("nda-review");
  });

  it("picks a bundled skill on its keywords like the server would", async () => {
    const { workshop } = workshopRig();

    const result = await workshop.test("Build me a slide deck.", undefined);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.name).toBe("slide-design");
    expect(result.preloaded).toEqual(["slide-design"]);
  });

  it("does not offer a stored record that breaks a rule", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc("contract-review"));
    await rig.store.add({ name: "plain-one", description: "x", body: "Body" });

    const result = await rig.workshop.test("hello", undefined);

    expect(result.listed).toEqual(["contract-review", "plain-one"]);
  });

  it("never writes anything", async () => {
    const rig = workshopRig();

    await rig.workshop.test("a clause", keyed("contract-review", "clause"));
    await rig.workshop.test("hello", doc("nda-review"), "contract-review");

    expect(await rig.store.list()).toEqual([]);
    expect([...(await rig.switches.disabled())]).toEqual([]);
    expect(rig.changes.count).toBe(0);
  });
});
