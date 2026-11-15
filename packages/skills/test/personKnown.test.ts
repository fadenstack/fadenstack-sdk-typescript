import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemoryApprovalStore, MemorySessionStore, ApprovalDecision } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";
import { MemorySkillStore, SkillsPersonUnknownError, skillsModule, type SkillsModule } from "@fadenstack/skills";

import { BUNDLED_SLIDE_DESIGN, doc } from "./workshopRig.js";
import { ask, calls, standalone, standard } from "./rig.js";

/**
 * The module knows the person from the profile's principal once the agent has asked for tools, whatever the policy says; before that
 * it lists the bundled skills only and refuses a change (as .NET's `SkillsModule`, commit 4526767).
 */
describe("whose skills these are", () => {
  const names = async (factory: IDBFactory) => ((await factory.databases()).map((d) => d.name ?? "")).filter((n) => n.startsWith("fadenstack-skills")).sort();

  async function governedAs(agent: Record<string, unknown>, module: SkillsModule) {
    const gateway = new FakeGateway({ users: [{ email: "anna@example.com", password: "secret" }], principal: true, agents: [{ slug: "docs", ...agent }], model: () => ({ text: "Hello." }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "anna@example.com", password: "secret", fetch: gateway.fetch }));
    return FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
      .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).use(module).build();
  }

  it("governed, before the agent starts: a save is refused, nothing is written, and the list holds the bundled skills only", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory, bundled: [BUNDLED_SLIDE_DESIGN] });
    const workshop = module.workshop();

    const saved = await workshop.save(doc("mine"));
    await expect(module.store!.add(standard("mine"))).rejects.toThrow(SkillsPersonUnknownError);
    await expect(module.store!.add(standard("mine"))).rejects.toThrow(/Whose skills these are is not known yet: start the agent first/);
    await expect(module.switches!.set("slide-design", false)).rejects.toThrow(SkillsPersonUnknownError);

    expect(saved.status).not.toBe("saved");
    expect(await module.store!.list()).toEqual([]);
    expect((await workshop.list()).map((s) => s.name)).toEqual(["slide-design"]);
    expect(await names(factory)).toEqual([]); // no database was made for a wrong person
  });

  it("governed, after the agent started: the governed person's database", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory, bundled: [BUNDLED_SLIDE_DESIGN] });
    const agent = await governedAs({ localSkills: { mode: "allow" } }, module);
    await agent.start();

    await module.store!.add(standard("annas"));
    await (await agent.startSession()).send("Hi");

    expect((await module.store!.list()).map((s) => s.name)).toEqual(["annas"]);
    expect(await names(factory)).toEqual(["fadenstack-skills:tenant-1:user-1"]);
    expect(module.skillNames).toEqual(expect.arrayContaining(["annas"]));
    await agent.dispose();
  });

  it("governed with local skills off: the module still knows the person, and offers the model no skills", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory, bundled: [BUNDLED_SLIDE_DESIGN] });
    const agent = await governedAs({ localSkills: { mode: "disable" } }, module);
    await agent.start();

    await module.store!.add(standard("annas")); // an editor can work on the person's skills
    expect(await names(factory)).toEqual(["fadenstack-skills:tenant-1:user-1"]);
    await (await agent.startSession()).send("Hi");

    expect(module.instructions).toBeUndefined();
    expect(module.skillNames).toEqual([]);
    await agent.dispose();
  });

  it("standalone: the standalone principal's database", async () => {
    const factory = new IDBFactory();
    const module = skillsModule({ indexedDB: factory });
    const rig = standalone({ module });
    await expect(module.store!.add(standard("early"))).rejects.toThrow(SkillsPersonUnknownError);

    await ask(rig, "Hello");
    await module.store!.add(standard("kept"));

    expect((await names(factory))).toEqual(["fadenstack-skills:standalone:standalone"]);
    await ask(rig, "Hi");
    expect(calls(rig.fake).at(-1)!.instructions).toContain("kept");
  });

  it("a store the app passes is the app's own, whoever the person is", async () => {
    const own = new MemorySkillStore();
    const mine = skillsModule({ store: own, switches: false });
    await mine.store!.add(standard("app-skill"));
    expect((await own.list()).map((s) => s.name)).toEqual(["app-skill"]);
  });
});
