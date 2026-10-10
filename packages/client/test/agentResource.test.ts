import { describe, expect, it } from "vitest";

import { FadenClient, decideTool, effectiveToolClass, loginWithPassword, narrowestMode, toWireEvent } from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

async function client(gateway: FakeGateway) {
  const { client, tokens } = FadenClient.forAgent({ serverUrl: gateway.serverUrl, agent: "excel", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  return client;
}

describe("AgentResource", () => {
  it("reads the profile in camelCase", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "excel", name: "Excel assistant", contract: [{ name: "write_cells", risk: "write" }], ceiling: "ask",
        ui: { greeting: "Hi", suggestions: ["Sum it"] } }],
    });
    const profile = await (await client(gateway)).agent!.getProfile();
    expect(profile).toMatchObject({
      slug: "excel",
      name: "Excel assistant",
      hostToolContract: [{ name: "write_cells", risk: "write" }],
      toolModes: { default: "ask", ceiling: "ask", openWorldEnforced: false },
      localMcp: { mode: "disable", developerMode: false },
      ui: { greeting: "Hi", suggestions: ["Sum it"] },
    });
  });

  it("reports events in the fields the server accepts, and nothing else", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "excel" }] });
    const c = await client(gateway);
    await c.agent!.report([
      { type: "tool.executed", tool: "read_range", source: "host", durationMs: 12.6, outcome: "ok", conversationId: "abc123" },
      { type: "approval.decided", tool: "write_cells", decision: "approved", waitMs: 2000 },
      { type: "approval.decided", tool: "delete_rows", decision: "approved", scope: "bypass" },
      { type: "session.stats", turns: 3 },
    ]);
    expect(gateway.reported.map((e) => e["type"])).toEqual(["tool.executed", "approval.decided", "approval.decided", "session.stats"]);
    expect(gateway.reported[2]).toEqual({ type: "approval.decided", occurred_at: expect.any(String), tool: "delete_rows", decision: "approved", scope: "bypass" });
    expect(gateway.reported[0]).toMatchObject({ duration_ms: 13, conversation_id: "abc123", source: "host" });
  });

  it("leaves out fields that are not set", () => {
    const wire = toWireEvent({ type: "tool.executed", tool: "t", durationMs: 1, outcome: "ok", occurredAt: new Date(0) });
    expect(wire).toEqual({ type: "tool.executed", tool: "t", duration_ms: 1, outcome: "ok", occurred_at: "1970-01-01T00:00:00.000Z" });
  });
});

describe("tool modes", () => {
  it("follows the table", () => {
    const table = (["off", "read_only", "ask", "auto"] as const).map((mode) =>
      (["read", "write", "destructive", "unknown"] as const).map((c) => decideTool(mode, c)).join(" "));
    expect(table).toEqual([
      "hidden hidden hidden hidden",
      "run hidden hidden hidden",
      "run ask ask ask",
      "run run ask ask",
    ]);
  });

  it("never widens past a ceiling, and takes the stricter class", () => {
    expect(narrowestMode("auto", "ask")).toBe("ask");
    expect(narrowestMode("read_only", "auto")).toBe("read_only");
    expect(narrowestMode("auto", null)).toBe("auto");
    expect(effectiveToolClass("read", "write")).toBe("write");
    expect(effectiveToolClass("destructive", "read")).toBe("destructive");
    expect(effectiveToolClass("unknown", "read")).toBe("read");
    expect(effectiveToolClass("write", undefined)).toBe("write");
  });
});
