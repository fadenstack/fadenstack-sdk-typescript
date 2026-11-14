import { describe, expect, it } from "vitest";

import { OpenAiFake } from "@fadenstack/testing";
import { RESERVED_TOOL_NAMES } from "@fadenstack/agents";
import { skillsModule, SKILL_TOOL_NAMES } from "@fadenstack/skills";

import { BASE, HOUSE_BODY, HOUSE_RESOURCE, ask, call, calls, standalone, standard } from "./rig.js";

/**
 * sdk/51 F04, port of the .NET `SkillsThroughOurLoopTests`: the two tools through the agent's own loop, with a scripted endpoint.
 * .NET runs Microsoft Agent Framework's `AgentSkillsProvider` there; TypeScript has its own loader, so the tests hold it to the
 * same behaviour: the tools offered, the instructions, a load and a resource read, no approval, no script, a path that leaves
 * the skill refused.
 */
describe("the skills through the agent's loop", () => {
  const skills = () => ({ bundled: [standard()] });

  it("offers load_skill and read_skill_resource, never run_skill_script", async () => {
    const rig = standalone({ skills: skills() });
    rig.fake.answers.push(OpenAiFake.text("Hello."));
    const agent = rig.builder.build();
    await (await agent.startSession()).send("Hi");

    const offered = calls(rig.fake)[0]!.tools;
    expect(offered).toContain("load_skill");
    expect(offered).toContain("read_skill_resource");
    expect(offered).not.toContain("run_skill_script");
    expect(offered).toHaveLength(2);
    expect(agent.tools.map((t) => t.name)).not.toContain("run_skill_script");
  });

  it("tells the model the skills' names and descriptions beside the agent's own instructions", async () => {
    const rig = standalone({ skills: skills() });

    await ask(rig, "Hi");

    const instructions = calls(rig.fake)[0]!.instructions!;
    expect(instructions).toContain("house-style");
    expect(instructions).toContain("Writes customer replies in the house style.");
    expect(instructions.startsWith(BASE)).toBe(true);
    expect(instructions).not.toContain(HOUSE_BODY); // progressive disclosure: the body comes with load_skill
    expect(instructions).toContain("load_skill");
    expect(instructions).not.toContain("run_skill_script"); // a prompt that told the model to run scripts would be the wrong one
    expect(instructions).toContain("Skills cannot run scripts here.");
  });

  it("answers a load_skill call with the body and a read_skill_resource call with the resource, and neither asks", async () => {
    const rig = standalone({ skills: skills() });
    rig.fake.answers.push(call("load_skill", { skillName: "house-style" }, "c1"));
    rig.fake.answers.push(call("read_skill_resource", { skillName: "house-style", resourceName: "references/tone.md" }, "c2"));
    rig.fake.answers.push(OpenAiFake.text("Done."));
    const agent = rig.builder.build();

    const result = await (await agent.startSession()).send("Write the reply.");

    expect(result.outcome).toBe("completed");
    const all = calls(rig.fake);
    expect(all).toHaveLength(3);
    expect(all[1]!.toolResults.join("\n")).toContain(HOUSE_BODY);
    expect(all[2]!.toolResults.join("\n")).toContain(HOUSE_RESOURCE);
    expect(rig.asked).toEqual([]); // both are class read: no approval
    for (const tool of agent.tools.filter((t) => t.source === "skills")) expect(tool.toolClass).toBe("read");
    expect(agent.tools.filter((t) => t.source === "skills")).toHaveLength(2);
  });

  it("gives the skill's content as MAF does: name, description, instructions and the resources it lists", async () => {
    const rig = standalone({ skills: skills() });
    rig.fake.answers.push(call("load_skill", { skillName: "house-style" }));

    await ask(rig, "Write the reply.");

    const content = calls(rig.fake)[1]!.toolResults[0]!;
    expect(content).toContain("<name>house-style</name>");
    expect(content).toContain("<description>Writes customer replies in the house style.</description>");
    expect(content).toContain(`<instructions>\n# House style\n${HOUSE_BODY}\n\n</instructions>`);
    expect(content).toContain('<resource name="references/tone.md"/>');
  });

  it("runs both tools in read-only mode too", async () => {
    const rig = standalone({ skills: skills(), mode: "read_only" });
    rig.fake.answers.push(call("load_skill", { skillName: "house-style" }));

    await ask(rig, "Write the reply.");

    expect(calls(rig.fake)[1]!.toolResults.join("\n")).toContain(HOUSE_BODY);
    expect(rig.asked).toEqual([]);
  });

  it("never runs a script, even when the model asks for it by name", async () => {
    const rig = standalone({ skills: { bundled: [standard("house-style", "Writes.", { resources: { "scripts/check.py": "open('mark', 'w')" } })] } });
    rig.fake.answers.push(call("run_skill_script", { skillName: "house-style", scriptName: "scripts/check.py" }));

    await ask(rig, "Run the check.");

    const answer = calls(rig.fake)[1]!.toolResults.join("\n");
    expect(answer).not.toContain("open(");
    expect(rig.asked).toEqual([]);
  });

  it("refuses a resource path that leaves the skill", async () => {
    for (const path of ["../../secret.md", "..\\..\\secret.md", "references/../../../secret.md", "/etc/passwd", "C:\\secret.md", "file:///secret.md"]) {
      const rig = standalone({ skills: { bundled: [standard(), standard("secret", "A secret skill.", { resources: { "x.md": "TOP SECRET" } })] } });
      rig.fake.answers.push(call("read_skill_resource", { skillName: "house-style", resourceName: path }));

      await ask(rig, "Read it.");

      const answer = calls(rig.fake)[1]!.toolResults.join(" ");
      expect(answer).not.toContain("TOP SECRET");
      expect(answer).toContain("not found in skill");
    }
  });

  it("answers an empty or unknown name with an error text, as MAF does", async () => {
    const rig = standalone({ skills: skills() });
    rig.fake.answers.push(call("load_skill", { skillName: "" }, "c1"));
    rig.fake.answers.push(call("load_skill", { skillName: "nothing" }, "c2"));
    rig.fake.answers.push(call("read_skill_resource", { skillName: "house-style", resourceName: " " }, "c3"));
    rig.fake.answers.push(call("read_skill_resource", { skillName: "nothing", resourceName: "a.md" }, "c4"));

    await ask(rig, "Read it.");

    const results = calls(rig.fake).at(-1)!.toolResults; // the history holds every earlier result
    expect(results).toContain("Error: Skill name cannot be empty.");
    expect(results).toContain("Error: Skill 'nothing' not found.");
    expect(results).toContain("Error: Resource name cannot be empty.");
    expect(results.filter((r) => r === "Error: Skill 'nothing' not found.")).toHaveLength(2);
  });

  it("only reads a resource by the name the skill lists", async () => {
    const rig = standalone({ skills: skills() });
    rig.fake.answers.push(call("read_skill_resource", { skillName: "house-style", resourceName: "tone.md" }));

    await ask(rig, "Hi");

    expect(calls(rig.fake)[1]!.toolResults.join(" ")).toContain("not found in skill");
  });

  it("is named skills, and its two tools are the SDK's reserved names", () => {
    expect(skillsModule().name).toBe("skills");
    for (const name of SKILL_TOOL_NAMES) expect(RESERVED_TOOL_NAMES).toContain(name);
    expect(SKILL_TOOL_NAMES).not.toContain("run_skill_script");
    expect([...SKILL_TOOL_NAMES]).toEqual(["load_skill", "read_skill_resource"]);
  });
});
