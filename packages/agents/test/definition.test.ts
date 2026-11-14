import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseToolClass } from "@fadenstack/client";
import { AgentDefinition } from "@fadenstack/agents";

/** sdk/51 F03, I03 commit 1: the agent definition an app ships, read in place of the server's profile. Port of the .NET AgentDefinitionTests. */
const TEMPLATES = ["word-assistant", "excel-assistant", "powerpoint-assistant", "outlook-assistant", "browser-assistant"];

/** Core's templates (release/0.7.1): the apps' own `contracts/*.json`, with `local_skills_mode` added (copied from the .NET tests). */
const template = (name: string): string => readFileSync(new URL(`./definitions/${name}.json`, import.meta.url), "utf8");

describe("AgentDefinition", () => {
  it.each(TEMPLATES)("reads %s with its contract and instructions", (name) => {
    const json = template(name);
    const raw = JSON.parse(json) as { name: string; version: { instructions: string; host_tool_contract: unknown[] } };

    const definition = AgentDefinition.fromJson(json);

    expect(definition.slug).toBe(name);
    expect(definition.name).toBe(raw.name);
    expect(definition.instructions).toBe(raw.version.instructions);
    expect(definition.hostToolContract).toHaveLength(raw.version.host_tool_contract.length);
    for (const entry of definition.hostToolContract) expect(parseToolClass(entry.risk)).not.toBe("unknown");
    expect(definition.localMcpMode).toBe("disable");
    expect(definition.localSkillsMode).toBe("disable");
    expect(definition.ui).not.toBeNull();
    expect(definition.ui).toHaveProperty("greeting");
  });

  it("reads an object as it reads the text, and keeps a copy", () => {
    const source = { slug: "a", version: { instructions: "Hi" } };
    const definition = AgentDefinition.fromJson(source);
    source.version.instructions = "changed";
    expect(definition.instructions).toBe("Hi");
    expect(JSON.parse(definition.toJson())).toEqual({ slug: "a", version: { instructions: "Hi" } });
  });

  it("keeps the browser template's server tools", () => {
    expect(AgentDefinition.fromJson(template("browser-assistant")).serverTools).toContain("current_time");
  });

  it("reads an unknown or missing risk as unclassified and never throws", () => {
    const definition = AgentDefinition.fromJson(`{"slug":"a","version":{"host_tool_contract":[
      {"name":"wipe","risk":"catastrophic"},
      {"name":"peek"},
      {"name":"note","risk":"  Write "},
      {"risk":"read"},
      {"name":"","risk":"read"},
      "junk",
      {"name":7,"risk":"read"}
    ]}}`);

    expect(definition.hostToolContract.map((e) => e.name)).toEqual(["wipe", "peek", "note"]);
    expect(definition.hostToolContract.map((e) => parseToolClass(e.risk))).toEqual(["unknown", "unknown", "write"]);
  });

  it("keeps a contract entry's other fields, and leaves out a target mapping it cannot read", () => {
    const definition = AgentDefinition.fromJson({ slug: "a", version: { host_tool_contract: [
      { name: "open", risk: "read", schema_sha256: "ab", approval: "always", target_type: "document", target_argument: "/path" },
      { name: "bad", risk: "read", target_type: "document", target_argument: "path" },
    ] } });

    expect(definition.hostToolContract).toEqual([
      { name: "open", risk: "read", schemaSha256: "ab", approval: "always", targetType: "document", targetArgument: "/path" },
      { name: "bad", risk: "read" },
    ]);
  });

  it.each([
    ['"allow"', "allow"], ['"ALLOW"', "allow"], ['" allow "', "allow"], ['"disable"', "disable"], ['"developer"', "disable"],
    ["1", "disable"], ["null", "disable"], ["true", "disable"],
  ])("reads the mode %s as %s", (value, expected) => {
    const definition = AgentDefinition.fromJson(`{"slug":"a","version":{"local_mcp_mode":${value},"local_skills_mode":${value}}}`);
    expect(definition.localMcpMode).toBe(expected);
    expect(definition.localSkillsMode).toBe(expected);
  });

  it("reads a definition without the skills mode, as the apps ship it, as disable", () => {
    const definition = AgentDefinition.fromJson(`{"slug":"a","version":{"local_mcp_mode":"allow"}}`);
    expect(definition.localMcpMode).toBe("allow");
    expect(definition.localSkillsMode).toBe("disable");
  });

  it("keeps unknown fields, writes them back whole, and ignores model_alias", () => {
    const json = `{"slug":"helper","name":"Helper","future":{"x":1},"version":{"instructions":"Be brief.","model_alias":"big",
      "ui":{"greeting":"Hi","languages":{"de":{"greeting":"Hallo"}},"reasoning":{"default":"low"},"delegates":["word-assistant"]},
      "next_field":[1,2]}}`;

    const definition = AgentDefinition.fromJson(json);

    expect(JSON.parse(definition.toJson())).toEqual(JSON.parse(json));
    expect((definition.json["future"] as { x: number }).x).toBe(1);
    expect((definition.ui!["languages"] as { de: { greeting: string } }).de.greeting).toBe("Hallo");
    expect(definition.ui).toHaveProperty("reasoning");
    expect(definition.ui).toHaveProperty("delegates");
    expect(definition.instructions).toBe("Be brief.");
    expect(definition).not.toHaveProperty("modelAlias");
  });

  it("stands in the slug for a name, and nothing for the rest", () => {
    const definition = AgentDefinition.fromJson(`{"slug":"bare"}`);
    expect(definition.name).toBe("bare");
    expect(definition.instructions).toBe("");
    expect(definition.hostToolContract).toEqual([]);
    expect(definition.ui).toBeNull();
    expect(definition.serverTools).toBeNull();
  });

  it.each(["[]", '"word-assistant"', "{}", '{"slug":""}', '{"slug":"Word"}', '{"slug":"-word"}', '{"slug":"word-"}', '{"slug":"../word"}',
    '{"slug":7}', "not json", "null", "7", '{"slug":"a\\n"}', '{"slug":"a b"}'])("refuses %s: no valid slug", (json) => {
    expect(() => AgentDefinition.fromJson(json)).toThrow(TypeError);
  });

  it("takes a slug of 64 characters and no more", () => {
    expect(AgentDefinition.fromJson({ slug: "a".repeat(64) }).slug).toHaveLength(64);
    expect(() => AgentDefinition.fromJson({ slug: "a".repeat(65) })).toThrow(TypeError);
  });

  it("refuses what is no object, as an object", () => {
    expect(() => AgentDefinition.fromJson([] as never)).toThrow(TypeError);
    expect(() => AgentDefinition.fromJson(null as never)).toThrow(TypeError);
  });

  it("keeps a __proto__ key as a plain field and never changes the definition's prototype", () => {
    const definition = AgentDefinition.fromJson(`{"slug":"a","__proto__":{"polluted":true},"version":{"ui":{"__proto__":{"x":1}}}}`);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(definition.json)).toBe(Object.prototype);
    expect(definition.slug).toBe("a");
    expect(Object.getPrototypeOf(definition.ui)).toBe(Object.prototype);
  });
});
