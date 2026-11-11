import { describe, expect, it } from "vitest";
import { FadenstackClient, decideTool, toAgentProfile } from "@fadenstack/client";

describe("0.7 approval wire compatibility", () => {
  it("retains the reviewed JSON-pointer target mapping for work grants", () => {
    const profile = toAgentProfile({ host_tool_contract: [{ name: "read", risk: "read", target_type: "document", target_argument: "/resource~1id" }] });
    expect(profile.hostToolContract[0]).toMatchObject({ targetType: "document", targetArgument: "/resource~1id" });
    expect(() => toAgentProfile({ host_tool_contract: [{ name: "read", target_type: "document", target_argument: "/bad~2key" }] })).toThrow();
  });
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
