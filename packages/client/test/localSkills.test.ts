import { describe, expect, it } from "vitest";

import { toAgentProfile } from "@fadenstack/client";

describe("the profile's local_skills (core 0.7.1)", () => {
  it("reads the mode and developer mode, as local_mcp has them", () => {
    const profile = toAgentProfile({ id: "a", slug: "a", local_skills: { mode: "allow", developer_mode: true } });
    expect(profile.localSkills).toEqual({ mode: "allow", developerMode: true });
  });

  it("is absent from a server that does not say, and disable where it says nothing of the mode", () => {
    expect(toAgentProfile({ id: "a", slug: "a" }).localSkills).toBeUndefined();
    expect(toAgentProfile({ id: "a", slug: "a", local_skills: {} }).localSkills).toEqual({ mode: "disable", developerMode: false });
    expect(toAgentProfile({ id: "a", slug: "a", local_skills: "allow" }).localSkills).toEqual({ mode: "disable", developerMode: false });
  });
});
