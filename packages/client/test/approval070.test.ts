import { describe, expect, it } from "vitest";
import { FadenstackClient, decideTool, toAgentProfile } from "@fadenstack/client";

describe("0.7 approval wire compatibility", () => {
  it("retains the maximum and standing restrictions without enabling unsupported modes", () => {
    const p = toAgentProfile({ tool_modes: { default: "ask", ceiling: "ask", max: "auto" },
      approvals: { standing: [], longest_grant_minutes: 0, grant_classes: [] } });
    expect(p.toolModes).toMatchObject({ default: "ask", ceiling: "ask", max: "auto" });
    expect(p.approvals).toEqual({ standing: [], longestGrantMinutes: 0, grantClasses: [] });
    expect(toAgentProfile({}).approvals).toBeUndefined();
  });

  it.each([
    { standing: ["unexpected"], longest_grant_minutes: 120, grant_classes: ["read"] },
    { standing: [], longest_grant_minutes: -1, grant_classes: ["read"] },
    { standing: [], longest_grant_minutes: 1.5, grant_classes: ["read"] },
    { standing: [], longest_grant_minutes: 120, grant_classes: ["destructive"] },
    { standing: [], longest_grant_minutes: 120, grant_classes: "read" },
    { standing: ["chat", "chat"], longest_grant_minutes: 120, grant_classes: ["read"] },
    null,
  ])("refuses malformed approval limits rather than treating them as unrestricted", approvals => {
    expect(() => toAgentProfile({ approvals })).toThrow("Invalid agent approval limits");
  });

  it("keeps Bypass metadata without treating it as a legacy Auto permission", () => {
    const p = toAgentProfile({ tool_modes: { max: "bypass" }, approvals: {
      standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"],
      bypass: { allowed: false, longest_minutes: 120, evidence: "calls",
        step_up: { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" } },
    } });
    expect(p.toolModes.max).toBe("bypass");
    expect(p.approvals?.bypass).toMatchObject({ allowed: false, stepUp: { required: true, maxAge: 300 } });
    expect(p.toolModes.default).toBe("ask");
    expect(() => toAgentProfile({ tool_modes: { max: "unreviewed" } })).toThrow();
  });

  it("preserves the legacy overload and sends explicit scopes with the new overload", async () => {
    const bodies: unknown[] = [];
    const client = new FadenstackClient({ serverUrl: "https://offline.test", agent: "nc", fetch: async (_input, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return Response.json({ status: "approved" });
    } });
    await client.agent!.answerApproval("one", true, new AbortController().signal);
    await client.agent!.answerApproval("two", true, "once");
    await client.agent!.answerApproval("three", false, "once", new AbortController().signal);
    expect(bodies).toEqual([{ approved: true }, { approved: true, scope: "once" }, { approved: false, scope: "once" }]);
  });

  it("contract approval never bypasses a hidden mode or a destructive/unknown class", () => {
    expect(decideTool("off", "read", "never")).toBe("hidden");
    expect(decideTool("read_only", "write", "never")).toBe("hidden");
    expect(decideTool("ask", "write", "never")).toBe("run");
    expect(decideTool("auto", "read", "always")).toBe("ask");
    expect(decideTool("auto", "write", "ask")).toBe("ask");
    expect(decideTool("auto", "destructive", "never")).toBe("ask");
    expect(decideTool("auto", "unknown", "never")).toBe("ask");
  });
});
