import { describe, expect, it } from "vitest";

import { ErrorCodes, FadenstackApiError, isAgentDisabled, toAgentProfile } from "@fadenstack/client";

// The off-switch's client part (core 0.7.1): the 403 `agent_disabled` told from other refusals, and the profile's `enabled`. The .NET SDK's
// AgentDisabledTests.

describe("a refusal with agent_disabled", () => {
  it.each([
    [403, "agent_disabled", true],
    [403, "agent_not_granted", false],
    [403, "agent_retired", false],
    [403, undefined, false],
    [400, "agent_disabled", false],
  ])("is told apart from other errors: status %i, code %s -> %s", (status, code, expected) => {
    const error = new FadenstackApiError(status, "No.", { ...(code ? { code } : {}), type: "permission_error" });
    expect(error.isAgentDisabled).toBe(expected);
    expect(isAgentDisabled(error)).toBe(expected);
    expect(isAgentDisabled(new Error("wrapped", { cause: error }))).toBe(expected); // also what an error was caused by
  });

  it("has its code", () => {
    expect(ErrorCodes.agentDisabled).toBe("agent_disabled");
    expect(isAgentDisabled("not an error")).toBe(false);
  });
});

describe("the profile's enabled", () => {
  it("says false when the server says so, and true when the key is missing, as from an older server", () => {
    expect(toAgentProfile({ id: "a", slug: "docs", name: "Docs", enabled: false }).enabled).toBe(false);
    expect(toAgentProfile({ id: "a", slug: "docs", name: "Docs", enabled: true }).enabled).toBe(true);
    expect(toAgentProfile({ id: "a", slug: "docs", name: "Docs" }).enabled).toBe(true);
  });
});
