import { describe, expect, it } from "vitest";

import { MachinePolicy, PolicyAccess, PolicyRule } from "@fadenstack/agents";
import { OpenAiFake } from "@fadenstack/testing";
import { MemorySkillStore, coreLocalSkillsPolicy, skillsModule } from "@fadenstack/skills";

import { BASE, Entries, ask, calls, governed, standalone, standard } from "./rig.js";

/**
 * The governed-mode rule (sdk/51 F04, R3-7, D10): with a server local skills are on only when the profile's `local_skills.mode` is
 * `allow` or its `developer_mode` is true; absent or unknown is off. Standalone they are on unless the person or the machine policy
 * turned them off, and a machine policy that lists sources keeps only the bundled skills. Port of the .NET `SkillsPolicyTests`.
 */
const decide = (mode: string | undefined, developerMode: boolean) =>
  coreLocalSkillsPolicy.decide({ localSkills: mode === undefined ? { mode: "", developerMode } : { mode, developerMode } } as never);

describe("the core policy", () => {
  it.each([
    ["allow", false, true],
    ["allow", true, true],
    ["disable", true, true], // developer mode, the owner's rule
    ["disable", false, false],
    ["", false, false],
    [undefined, false, false],
    ["mystery", false, false], // unknown is off
    ["mystery", true, true], // as local MCP: the person's developer mode is their own
  ] as const)("reads mode %j and developer mode %j as local MCP does: %j", (mode, developer, allowed) => {
    expect(decide(mode, developer).allowed).toBe(allowed);
  });

  it("is off for a profile that says nothing about skills", () => {
    expect(coreLocalSkillsPolicy.decide({} as never).allowed).toBe(false);
  });

  it("says why: the reason is shown to the person", () => {
    expect(decide("mystery", false).reason).toContain("'mystery'");
    expect(decide("disable", false).reason).toBe("The agent does not allow local skills.");
    expect(decide("allow", false).reason).toBe("The agent allows local skills.");
    expect(decide("disable", true).reason).toBe("Developer mode.");
  });
});

describe("with a server", () => {
  async function governedOffers(localSkills: { mode?: string; developerMode?: boolean } | undefined): Promise<boolean> {
    const module = skillsModule({ bundled: [standard()], store: false });
    const { gateway, agent } = await governed(localSkills ? { localSkills } : {}, module);
    const session = await agent.startSession();
    await session.send("Hi");

    const offered = agent.tools.some((t) => t.name === "load_skill" || t.name === "read_skill_resource");
    const told = JSON.stringify(gateway.modelCalls[0]!.body).includes("house-style");
    expect(offered).toBe(told); // what the module offers is what the model is told
    expect(gateway.modelCalls[0]!.tools.some((t) => t.name === "load_skill")).toBe(offered);
    return offered;
  }

  it.each([
    [{ mode: "allow", developerMode: false }, true],
    [{ mode: "disable", developerMode: true }, true],
    [{ mode: "disable", developerMode: false }, false],
    [{ mode: "mystery", developerMode: false }, false],
    [{ developerMode: false }, false],
    [undefined, false], // an older server: the profile has no local_skills at all
  ] as const)("follows the profile: %j is %j", async (localSkills, on) => {
    expect(await governedOffers(localSkills as { mode?: string; developerMode?: boolean } | undefined)).toBe(on);
  });

  it("takes the tools as read unless the agent's contract lists them: then the contract's word, never a looser one", async () => {
    const module = skillsModule({ bundled: [standard()], store: false });
    const { agent } = await governed({ localSkills: { mode: "allow" }, contract: [{ name: "read_page", risk: "read" }, { name: "load_skill", risk: "write" }] }, module);
    await agent.start();

    const tools = Object.fromEntries(agent.tools.filter((t) => t.source === "skills").map((t) => [t.name, t.toolClass]));
    expect(tools).toEqual({ load_skill: "write", read_skill_resource: "read" });
  });

  it("is off where the machine policy forbids skills, whatever the server says", async () => {
    const module = skillsModule({ bundled: [standard()], store: false });
    const { agent } = await governed({ localSkills: { mode: "allow" } }, module, undefined, (b) => b.useMachinePolicy(new MachinePolicy({ skills: PolicyRule.forbidden })));
    await agent.start();
    expect(agent.tools.map((t) => t.name)).not.toContain("load_skill");
  });
});

describe("standalone", () => {
  it("is on by default and off when the person turned local skills off", async () => {
    const on = standalone({ skills: { bundled: [standard()] } }).builder.build();
    await on.start();
    expect(on.tools.map((t) => t.name)).toContain("load_skill");

    const off = standalone({ skills: { bundled: [standard()] }, local: { localSkills: false } }).builder.build();
    await off.start();
    expect(off.tools.map((t) => t.name)).not.toContain("load_skill");
    expect(off.tools.map((t) => t.name)).not.toContain("read_skill_resource");
  });

  it("is off where the machine policy forbids skills", async () => {
    const rig = standalone({ skills: { bundled: [standard()] }, policy: new MachinePolicy({ skills: PolicyRule.forbidden }) });

    await ask(rig, "Hi");

    const call = calls(rig.fake)[0]!;
    expect(call.tools).toEqual([]);
    expect(call.instructions).toBe(BASE);
  });

  it("is off where the machine policy lists nothing", async () => {
    const agent = standalone({ skills: { bundled: [standard()] }, policy: new MachinePolicy({ skills: new PolicyRule(PolicyAccess.Listed, []) }) }).builder.build();

    await agent.start();

    expect(agent.tools.map((t) => t.name)).not.toContain("load_skill");
  });

  it("keeps only the bundled skills where the machine policy lists sources (in a browser a list names no folder)", async () => {
    const store = new MemorySkillStore();
    await store.add(standard("own-skill", "The person's own."));
    const logs = new Entries();
    const policy = new MachinePolicy({ skills: new PolicyRule(PolicyAccess.Listed, ["/skills/listed"]) });
    const rig = standalone({ skills: { bundled: [standard("bundled-skill", "From the app.")], store }, policy, logs });

    await ask(rig, "Hi");

    const instructions = calls(rig.fake)[0]!.instructions!;
    expect(instructions).toContain("bundled-skill");
    expect(instructions).not.toContain("own-skill");
    expect(logs.lines.some((l) => l.eventId === 3103)).toBe(true);
  });

  it("leaves the model call as it was when skills are off", async () => {
    const rig = standalone({ skills: { bundled: [standard()] }, local: { localSkills: false } });
    rig.fake.answers.push(OpenAiFake.text("Hello."));

    await ask(rig, "Hi");

    const call = calls(rig.fake)[0]!;
    expect(call.tools).toEqual([]);
    expect(call.instructions).toBe(BASE);
  });

  it("lets an app's own policy replace the core one", async () => {
    const logs = new Entries();
    const rig = standalone({ skills: { bundled: [standard()], policy: { decide: () => ({ allowed: false, reason: "Not here." }) }, logger: logs } });
    const agent = rig.builder.build();

    await agent.start();

    expect(agent.tools.map((t) => t.name)).not.toContain("load_skill");
    expect(logs.lines.some((l) => l.message === "Skills are off: Not here.")).toBe(true);
    expect(rig.module?.instructions).toBeUndefined();
  });
});
