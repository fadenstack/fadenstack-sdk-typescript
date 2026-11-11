import { describe, expect, it } from "vitest";
import { FadenstackClient, toAgentGrant } from "@fadenstack/client";

const now = "2026-11-11T12:00:00+00:00";
const grant = { object: "agent.grant", id: "synthetic", kind: "time", status: "active", agent_id: "agent", agent_version: 1,
  device_id: "device", conversation_id: null, scope: { tools: ["read_page"], classes: ["read"] }, issued_at: now,
  expires_at: "2026-11-11T12:30:00+00:00", remaining_s: 1800, max_calls: 20, calls_used: 0, paused_at: null,
  revoked_at: null, revoked_by: null, evidence_level: "decisions", step_up: null, server_now: now, narrowed: ["minutes"] };

function fixture(reply: (path: string, method: string, body: unknown) => Response = () => Response.json(grant)) {
  const requests: { path: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const client = new FadenstackClient({ serverUrl: "https://offline.test", agent: "nc", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return reply(path, method, body);
  } });
  return { api: client.agent!, requests };
}

describe("server-held grants", () => {
  it("maps only the returned scope, server clock and narrowed limits", async () => {
    const { api, requests } = fixture();
    const result = await api.createGrant({ kind: "time", minutes: 120, tools: ["read_page"], maxCalls: 20,
      shownTextSha256: "a".repeat(64), clientVersion: "test" }, { conversationId: "chat" });
    expect(result).toMatchObject({ remainingSeconds: 1800, serverNow: now, narrowed: ["minutes"], scope: { tools: ["read_page"] } });
    expect(requests[0]).toMatchObject({ path: "/v1/agents/nc/grants", method: "POST",
      body: { kind: "time", minutes: 120, tools: ["read_page"], max_calls: 20, shown_text_sha256: "a".repeat(64), client_version: "test" },
      headers: { "x-faden-conversation-id": "chat" } });
  });

  it("implements inspection, pause/resume, revocation and extension without creating another grant", async () => {
    const { api, requests } = fixture();
    await api.getGrant("synthetic"); await api.pauseGrant("synthetic"); await api.resumeGrant("synthetic");
    await api.extendGrant("synthetic", { minutes: 15, shownTextSha256: "b".repeat(64) }); await api.revokeGrant("synthetic");
    expect(requests.map(r => [r.method, r.path])).toEqual([
      ["GET", "/v1/agents/nc/grants/synthetic"], ["POST", "/v1/agents/nc/grants/synthetic/pause"],
      ["POST", "/v1/agents/nc/grants/synthetic/resume"], ["POST", "/v1/agents/nc/grants/synthetic/extend"],
      ["DELETE", "/v1/agents/nc/grants/synthetic"],
    ]);
    expect(requests[3]!.body).toEqual({ minutes: 15, shown_text_sha256: "b".repeat(64) });
  });

  it("parses lists with the server clock and rejects malformed status/scope/budgets", async () => {
    const { api } = fixture(() => Response.json({ object: "list", data: [grant], server_now: now }));
    expect((await api.listGrants()).data[0]!.serverNow).toBe(now);
    for (const patch of [{ status: "unknown" }, { remaining_s: -1 }, { scope: {} }, { max_calls: -1 }, { server_now: "not-a-date" }])
      expect(() => toAgentGrant({ ...grant, ...patch })).toThrow();
  });

  it("never resends create on a server failure and preserves the typed refusal", async () => {
    const { api, requests } = fixture(() => Response.json({ error: { message: "Unavailable", code: "grant_limits_unavailable", type: "server_error" } }, { status: 503 }));
    await expect(api.createGrant({ kind: "time", minutes: 30, tools: ["read_page"] })).rejects.toMatchObject({ status: 503, code: "grant_limits_unavailable" });
    expect(requests).toHaveLength(1);
  });

  it("reports device calls with the exact wire names", async () => {
    const { api, requests } = fixture(() => Response.json({ object: "agent.grant_report", matched: 1, device_only: 0, gateway_only: 0 }));
    expect(await api.reportGrant("synthetic", ["call-one"])).toEqual({ matched: 1, deviceOnly: 0, gatewayOnly: 0 });
    expect(requests[0]!.body).toEqual({ calls: ["call-one"] });
  });
});

describe("Bypass step-up wire", () => {
  const start = { step_up_code: "synthetic-private-code", user_code: "AAAA-BBBB", verification_uri: "https://offline.test/step-up",
    verification_uri_complete: "https://offline.test/step-up#AAAA-BBBB", expires_in: 600, interval: 5 };

  it("starts only on explicit request and prevents a foreign sign-in origin", async () => {
    const { api, requests } = fixture(() => Response.json(start));
    expect(requests).toHaveLength(0);
    expect(await api.startStepUp(30, "test")).toMatchObject({ userCode: "AAAA-BBBB", interval: 5 });
    expect(requests[0]).toMatchObject({ path: "/api/agent-tokens/step-ups", body: { longest_minutes: 30, client_version: "test" } });
    const foreign = fixture(() => Response.json({ ...start, verification_uri_complete: "https://foreign.test/step-up" }));
    await expect(foreign.api.startStepUp()).rejects.toThrow("origin changed");
  });

  it("returns polling states and sends the proof only as the grant header", async () => {
    const { api, requests } = fixture(path => path.endsWith("/token")
      ? Response.json({ error: "slow_down", interval: 10 }, { status: 400 }) : Response.json(grant));
    expect(await api.pollStepUp("synthetic-private-code")).toEqual({ error: "slow_down", interval: 10 });
    await api.createGrant({ kind: "bypass", minutes: 30 }, { conversationId: "chat", stepUpProof: "synthetic-proof" });
    expect(requests[1]!.headers).toMatchObject({ "x-faden-step-up": "synthetic-proof", "x-faden-conversation-id": "chat" });
    expect(JSON.stringify(requests[1]!.body)).not.toContain("synthetic-proof");
  });

  it("parses a completed proof and exposes invalid states as failures", async () => {
    const { api } = fixture(() => Response.json({ proof: "synthetic-proof", expires_in: 300, signed_in_at: now, method: "password" }));
    expect(await api.pollStepUp("synthetic-private-code")).toEqual({ proof: "synthetic-proof", expiresIn: 300, signedInAt: now, method: "password" });
    const bad = fixture(() => Response.json({ error: "unexpected" }, { status: 400 }));
    await expect(bad.api.pollStepUp("synthetic-private-code")).rejects.toThrow();
  });
});
