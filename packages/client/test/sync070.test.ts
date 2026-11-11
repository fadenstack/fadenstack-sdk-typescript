import { describe, expect, it } from "vitest";
import { FadenstackClient, toAgentGrants, type TokenProvider } from "@fadenstack/client";

// The client-side fixes of the SDK sync against core 0.7.0 (fadenstack-dev sdk/43 §2: T4, T5, T6).

const now = "2026-11-11T12:00:00+00:00";
const grant = { object: "agent.grant", id: "one", kind: "time", status: "active", agent_id: "agent", agent_version: 1,
  device_id: "device", conversation_id: null, scope: { tools: ["read_page"], classes: ["read"] }, issued_at: now,
  expires_at: "2026-11-11T12:30:00+00:00", remaining_s: 1800, max_calls: null, calls_used: 0, paused_at: null,
  revoked_at: null, revoked_by: null, evidence_level: "decisions", step_up: null, server_now: now, narrowed: [] };

class CountingTokens implements TokenProvider {
  issued = 0;
  readonly invalidated: string[] = [];
  async getAccessToken(): Promise<string> { return `token-${++this.issued}`; }
  async invalidate(rejected: string): Promise<void> { this.invalidated.push(rejected); }
}

function client(reply: () => Response) {
  const tokens = new CountingTokens();
  const sent: string[] = [];
  const c = new FadenstackClient({ serverUrl: "https://offline.test", agent: "nc", credentials: tokens, fetch: async (_input, init) => {
    sent.push(new Headers(init?.headers).get("authorization") ?? "");
    return reply();
  } });
  return { api: c.agent!, tokens, sent };
}

describe("a step-up challenge (T4)", () => {
  const challenge = () => Response.json(
    { error: { message: "Switching on Bypass needs a fresh sign-in.", code: "bypass_step_up_required", type: "authentication_error" } },
    { status: 401, headers: { "www-authenticate": 'Bearer error="insufficient_user_authentication", max_age="300"' } });

  it("is not a bad token: no refresh and no second request, and the caller gets the code", async () => {
    const { api, tokens, sent } = client(challenge);
    await expect(api.createGrant({ kind: "bypass", minutes: 30 }, { stepUpProof: "stale-proof" }))
      .rejects.toMatchObject({ status: 401, code: "bypass_step_up_required" });
    expect(sent).toEqual(["Bearer token-1"]);
    expect(tokens.invalidated).toEqual([]);
  });

  it("while any other 401 still gets one retry with a fresh token", async () => {
    let first = true;
    const { api, tokens, sent } = client(() => {
      if (first) { first = false; return Response.json({ error: { message: "expired", type: "authentication_error" } }, { status: 401 }); }
      return Response.json({ object: "list", data: [], server_now: now });
    });
    await api.listGrants();
    expect(sent).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(tokens.invalidated).toEqual(["token-1"]);
  });
});

describe("a grant list with a grant this SDK cannot read (T5)", () => {
  it("keeps the others and leaves that one out", async () => {
    const later = [{ ...grant, id: "plan", kind: "plan" }, { ...grant, id: "odd", status: "queued" },
      { ...grant, id: "level", evidence_level: "full" }, { ...grant, id: "bad", remaining_s: -1 }];
    const { api } = client(() => Response.json({ object: "list", data: [grant, ...later], server_now: now }));
    expect((await api.listGrants()).data.map((g) => g.id)).toEqual(["one"]);
    expect(toAgentGrants([...later], now)).toEqual([]);
  });
});

describe("a development server over http (T6)", () => {
  it("signs in where the app allows it, as the client does", () => {
    expect(() => FadenstackClient.forAgent({ serverUrl: "http://dev.lan:8080", agent: "nc", allowInsecureHttp: true })).not.toThrow();
    expect(() => FadenstackClient.forAgent({ serverUrl: "http://dev.lan:8080", agent: "nc" })).toThrow(/https/);
  });
});
