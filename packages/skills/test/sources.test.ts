import { describe, expect, it } from "vitest";

import { OpenAiFake } from "@fadenstack/testing";
import { MemorySkillStore, skillsModule, type SkillStore } from "@fadenstack/skills";

import { ask, call, calls, standalone, standard } from "./rig.js";

/** The sources: bundled skills and the person's own, listed together. Port of the .NET `SkillSourcesTests`. */
describe("the sources", () => {
  it("loads a bundled skill and reads its resource without any store", async () => {
    const rig = standalone({
      skills: { bundled: [{ name: "slide-design", description: "Designs a slide.", body: "Use one idea per slide.", resources: { layouts: "Title, then two columns." } }] },
    });
    rig.fake.answers.push(call("load_skill", { skillName: "slide-design" }, "c1"));
    rig.fake.answers.push(call("read_skill_resource", { skillName: "slide-design", resourceName: "layouts" }, "c2"));
    rig.fake.answers.push(OpenAiFake.text("Done."));

    await ask(rig, "Make a slide.");

    const all = calls(rig.fake);
    expect(all[0]!.instructions).toContain("slide-design");
    expect(all[1]!.toolResults.join(" ")).toContain("Use one idea per slide.");
    expect(all[2]!.toolResults.join(" ")).toContain("Title, then two columns.");
    expect(rig.asked).toEqual([]);
  });

  it("lists the person's skills with the bundled ones, and a bundled name is not taken by a stored skill", async () => {
    const store = new MemorySkillStore();
    await store.add(standard("house-style", "From the store."));
    await store.add(standard("store-only"));
    await store.add(standard("extra-skill"));
    const rig = standalone({ skills: { store, bundled: [{ name: "house-style", description: "From the app.", body: "Bundled body." }] } });
    rig.fake.answers.push(call("load_skill", { skillName: "house-style" }));

    await ask(rig, "Hi");

    const all = calls(rig.fake);
    const instructions = all[0]!.instructions!;
    expect(instructions).toContain("store-only");
    expect(instructions).toContain("extra-skill");
    expect(instructions).toContain("From the app.");
    expect(instructions).not.toContain("From the store.");
    expect(all[1]!.toolResults.join(" ")).toContain("Bundled body.");
  });

  it("reads only the resources the skill lists", async () => {
    const rig = standalone({ skills: { bundled: [standard()] } });
    rig.fake.answers.push(call("read_skill_resource", { skillName: "house-style", resourceName: "scripts/check.py" }));

    await ask(rig, "Hi");

    expect(calls(rig.fake)[1]!.toolResults.join(" ")).toContain("Resource 'scripts/check.py' not found in skill 'house-style'");
  });

  it("offers a skill added later from the next turn, after refresh", async () => {
    const module = skillsModule({ store: new MemorySkillStore(), bundled: [standard()] });
    const rig = standalone({ module });
    const agent = rig.builder.build();
    const session = await agent.startSession();

    await session.send("First.");
    module.refresh(); // no change: the skills are read again, the same ones
    await module.store!.add(standard("added-later")); // the store tells the module: the next turn reads the sources again
    await session.send("Second.");

    const all = calls(rig.fake);
    expect(all[0]!.instructions).not.toContain("added-later");
    expect(all[1]!.instructions).toContain("added-later");
  });

  it("stops offering a skill that was removed", async () => {
    const store = new MemorySkillStore();
    await store.add(standard("short-lived"));
    const module = skillsModule({ store });
    const rig = standalone({ module });
    const session = await rig.builder.build().startSession();

    await session.send("First.");
    await store.remove("short-lived");
    await session.send("Second.");

    const all = calls(rig.fake);
    expect(all[0]!.instructions).toContain("short-lived");
    expect(all[1]!.instructions ?? "").not.toContain("short-lived");
  });

  it("reads the sources once per refresh, not on every turn", async () => {
    const store = new MemorySkillStore();
    await store.add(standard());
    let reads = 0;
    const read = store.list.bind(store);
    store.list = async () => {
      reads++;
      return read();
    };
    const module = skillsModule({ store });
    const rig = standalone({ module });
    const session = await rig.builder.build().startSession();

    await session.send("One.");
    await session.send("Two.");
    await session.send("Three.");

    expect(reads).toBe(1);
  });

  it("has no skills without the module", async () => {
    const rig = standalone({ without: true });

    await ask(rig, "Hi");

    expect(calls(rig.fake)[0]!.tools).not.toContain("load_skill");
    expect(calls(rig.fake)[0]!.instructions).toBe("You are the docs assistant.");
  });

  it("keeps the first of two bundled skills with one name", async () => {
    const rig = standalone({ skills: { bundled: [standard("same-name", "The first."), standard("same-name", "The second.")] } });

    await ask(rig, "Hi");

    const instructions = calls(rig.fake)[0]!.instructions!;
    expect(instructions).toContain("The first.");
    expect(instructions).not.toContain("The second.");
  });

  it("offers no tool and lists nothing while there is no skill", async () => {
    const rig = standalone({ skills: {} });

    await ask(rig, "Hi");

    expect(calls(rig.fake)[0]!.tools).toEqual([]);
    expect(calls(rig.fake)[0]!.instructions).toBe("You are the docs assistant.");
  });

  it("has an option for no store of the person's own", () => {
    const module = skillsModule({ store: false });
    const own: SkillStore | undefined = module.store;
    expect(own).toBeUndefined();
  });
});
