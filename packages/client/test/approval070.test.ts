import { describe, expect, it } from "vitest";
import { FadenstackClient, decideTool, toAgentProfile } from "@fadenstack/client";

describe("0.7 approval wire compatibility", () => {
  it("retains the reviewed JSON-pointer target mapping for work grants", () => {
    const profile = toAgentProfile({ host_tool_contract: [{ name: "read", risk: "read", target_type: "document", target_argument: "/resource~1id" }] });
    expect(profile.hostToolContract[0]).toMatchObject({ targetType: "document", targetArgument: "/resource~1id" });
    // A mapping this SDK cannot read is left out (a work grant never covers that tool), and the profile still loads.
    for (const bad of [{ target_type: "document", target_argument: "/bad~2key" }, { target_type: "mailbox", target_argument: "/id" },
      { target_type: "document", target_argument: "id" }]) {
      const entry = toAgentProfile({ host_tool_contract: [{ name: "read", risk: "read", ...bad }] }).hostToolContract[0]!;
      expect(entry).toEqual({ name: "read", risk: "read" });
    }
  });
  it("retains the maximum and standing restrictions without enabling unsupported modes", () => {
    const p = toAgentProfile({ tool_modes: { default: "ask", ceiling: "ask", max: "auto" },
      approvals: { standing: [], longest_grant_minutes: 0, grant_classes: [] } });
    expect(p.toolModes).toMatchObject({ default: "ask", ceiling: "ask", max: "auto" });
    expect(p.approvals).toEqual({ standing: [], longestGrantMinutes: 0, grantClasses: [] });
    expect(toAgentProfile({}).approvals).toBeUndefined();
  });

  it.each([
    [{ standing: ["unexpected"], longest_grant_minutes: 120, grant_classes: ["read"] }, { standing: [], longestGrantMinutes: 120, grantClasses: ["read"] }],
    [{ standing: ["chat", "later"], longest_grant_minutes: 120, grant_classes: ["read"] }, { standing: ["chat"], longestGrantMinutes: 120, grantClasses: ["read"] }],
    [{ standing: [], longest_grant_minutes: -1, grant_classes: ["read"] }, { standing: [], longestGrantMinutes: 0, grantClasses: ["read"] }],
    [{ standing: [], longest_grant_minutes: 1.5, grant_classes: ["read"] }, { standing: [], longestGrantMinutes: 0, grantClasses: ["read"] }],
    [{ standing: [], longest_grant_minutes: 120, grant_classes: ["destructive"] }, { standing: [], longestGrantMinutes: 120, grantClasses: [] }],
    [{ standing: [], longest_grant_minutes: 120, grant_classes: "read" }, { standing: [], longestGrantMinutes: 120, grantClasses: [] }],
    [{ standing: "chat", longest_grant_minutes: 120, grant_classes: ["read"] }, { standing: [], longestGrantMinutes: 120, grantClasses: ["read"] }],
    [{ standing: ["chat", "chat"], longest_grant_minutes: 120, grant_classes: ["read"] }, { standing: ["chat"], longestGrantMinutes: 120, grantClasses: ["read"] }],
    [null, { standing: [], longestGrantMinutes: 0, grantClasses: [] }],
    ["any", { standing: [], longestGrantMinutes: 0, grantClasses: [] }],
  ])("narrows malformed or unknown approval limits, never widens them and never fails the profile (%j)", (approvals, expected) => {
    expect(toAgentProfile({ approvals }).approvals).toEqual(expected);
  });

  it("reads an unknown level as read only, and no level or Bypass as no limit", () => {
    expect(toAgentProfile({ tool_modes: { ceiling: "supervised", max: "later" } }).toolModes).toMatchObject({ ceiling: "read_only", max: "read_only" });
    expect(toAgentProfile({ tool_modes: { ceiling: "bypass", max: "bypass" } }).toolModes).toMatchObject({ ceiling: null, max: "bypass" });
    const none = toAgentProfile({ tool_modes: { ceiling: null } }).toolModes;
    expect(none.ceiling).toBeNull();
    expect(none.max).toBeUndefined();
    expect(toAgentProfile({ tool_modes: { default: "bypass" } }).toolModes.default).toBe("ask");
  });

  it("does not allow Bypass the server describes incompletely or with another sign-in route", () => {
    const bypass = (b: unknown) => toAgentProfile({ approvals: { standing: null, longest_grant_minutes: 120, grant_classes: ["read"], bypass: b } }).approvals!.bypass;
    const step = { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" };
    expect(bypass({ allowed: true, longest_minutes: 60, evidence: "calls", step_up: step })).toMatchObject({ allowed: true, longestMinutes: 60 });
    expect(bypass({ allowed: true, longest_minutes: 60, evidence: "calls", step_up: { ...step, start: "https://elsewhere.test/x" } })!.allowed).toBe(false);
    expect(bypass({ allowed: true, longest_minutes: 60, evidence: "calls", step_up: { ...step, required: false } })!.allowed).toBe(false);
    expect(bypass({ allowed: "yes", step_up: step })!.allowed).toBe(false);
    expect(bypass({ allowed: true, longest_minutes: 60, evidence: "full", step_up: step })).toMatchObject({ allowed: true, evidence: "full" });
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
    expect(toAgentProfile({ tool_modes: { max: "unreviewed" } }).toolModes.max).toBe("read_only");
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

  it("attributes model host checks with the native tool-call id and session headers", async () => {
    let captured: unknown;
    let headers: Headers | undefined;
    const client = new FadenstackClient({ serverUrl: "https://offline.test", agent: "nc", fetch: async (_input, init) => {
      captured = JSON.parse(init!.body as string);
      headers = new Headers(init?.headers);
      return Response.json({ decision: "ask", tool_class: "destructive", effective_tool_mode: "ask", required_by_rule: true,
        message: "Review", profile_stamp: "a".repeat(64), arguments_stamp: "b".repeat(64), decision_stamp: "c".repeat(64),
        principal: { tenant_id: "tenant", user_id: "user", agent_id: "agent", device_id: "device" } });
    } });
    await client.agent!.checkHostTool({ name: "nc_test", arguments: { value: "reviewed" }, toolMode: "ask", origin: "model_tool",
      callId: "model-call", phase: "prepare", schemaSha256: "d".repeat(64), conversationId: "chat", turnId: "turn" });
    expect(captured).toMatchObject({ origin: "model_tool", call_id: "model-call", arguments: { value: "reviewed" } });
    expect(headers?.get("x-faden-conversation-id")).toBe("chat");
    expect(headers?.get("x-faden-turn-id")).toBe("turn");
  });
});
