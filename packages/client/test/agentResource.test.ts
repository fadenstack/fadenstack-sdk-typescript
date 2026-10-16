import { describe, expect, it } from "vitest";

import { FadenstackClient, decideTool, effectiveToolClass, loginWithPassword, narrowestMode, toWireEvent } from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

async function client(gateway: FakeGateway) {
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "excel", fetch: gateway.fetch });
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
      user: { language: null },
    });
  });

  it("says whether the model sees pictures and whether skills can be picked", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "excel", vision: true, skills: [] }] });
    expect(await (await client(gateway)).agent!.getProfile()).toMatchObject({ vision: true, images: false, skills: true });
    const older = new FakeGateway({ agents: [{ slug: "excel" }] });
    expect(await (await client(older)).agent!.getProfile()).toMatchObject({ vision: null, skills: false });
  });

  it("lists the skills the user can pick, narrowed on the server", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "excel", skills: [{ slug: "pivot", name: "Pivot tables", description: "Builds one" }, { slug: "chart", description: "Draws a chart" }] }],
    });
    const c = await client(gateway);
    expect(await c.agent!.listSkills()).toEqual({
      available: true,
      skills: [
        { id: "skill-pivot", slug: "pivot", name: "Pivot tables", description: "Builds one", activation: "manual" },
        { id: "skill-chart", slug: "chart", name: "chart", description: "Draws a chart", activation: "manual" },
      ],
    });
    expect((await c.agent!.listSkills({ query: "  draws ", limit: 500 })).skills.map((s) => s.slug)).toEqual(["chart"]);
    const request = gateway.requests.at(-1)!;
    expect(request.path).toBe("/v1/agents/excel/skills");
    expect((await c.agent!.listSkills({ limit: 0 })).skills.length).toBe(1);
  });

  it("offers no skills on a server without them, or one too old for the route", async () => {
    const without = new FakeGateway({ agents: [{ slug: "excel" }] });
    expect(await (await client(without)).agent!.listSkills()).toEqual({ available: false, skills: [] });
    const old = new FakeGateway({ agents: [{ slug: "excel" }] });
    const fetch404: typeof old.fetch = (input, init) => String(input instanceof Request ? input.url : input).includes("/skills")
      ? Promise.resolve(new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }))
      : old.fetch(input, init);
    const { client: oldClient, tokens } = FadenstackClient.forAgent({ serverUrl: old.serverUrl, agent: "excel", fetch: fetch404 });
    await tokens.signIn(await loginWithPassword({ apiUrl: old.serverUrl, email: "user@example.com", password: "secret", fetch: old.fetch }));
    expect(await oldClient.agent!.listSkills()).toEqual({ available: false, skills: [] });
  });

  it("keeps the user's language for all their clients, and forgets it", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "excel" }] });
    const c = await client(gateway);
    await expect(c.agent!.setUserLanguage("de-AT")).resolves.toBe("de-AT");
    expect((await c.agent!.getProfile()).user).toEqual({ language: "de-AT" });
    expect(gateway.languageOf("user@example.com")).toBe("de-AT");
    await expect(c.agent!.setUserLanguage(null)).resolves.toBeNull();
    expect((await c.agent!.getProfile()).user.language).toBeNull();
    await expect(c.agent!.setUserLanguage("Deutsch")).rejects.toThrow(/language tag/);
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
