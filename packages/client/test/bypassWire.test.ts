import { describe, expect, it } from "vitest";

import {
  BYPASS_SUPPORTS,
  CLIENT_SUPPORTS_HEADER,
  FadenstackClient,
  FadenstackError,
  FadenstackTransport,
  TOOL_MODES,
  decideTool,
  loginWithPassword,
  narrowestMode,
  parseToolMode,
  toAgentProfile,
  type FetchLike,
  type ToolClass,
} from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

/** A fetch that answers every request with `body` and keeps what it was asked. */
function recorder(body: unknown = {}, status = 200) {
  const seen: { url: string; headers: Headers; method: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { seen, fetch };
}

describe("Bypass as a tool mode", () => {
  it("runs reads and writes like auto and asks for the rest: the conversation's grant covers those", () => {
    const classes: ToolClass[] = ["read", "write", "destructive", "unknown"];
    expect(classes.map((c) => decideTool("bypass", c))).toEqual(classes.map((c) => decideTool("auto", c)));
    expect(classes.map((c) => decideTool("bypass", c))).toEqual(["run", "run", "ask", "ask"]);
    // a contract's hint never unhides or loosens what the class asks
    expect(decideTool("bypass", "destructive", "never")).toBe("ask");
    expect(decideTool("bypass", "write", "always")).toBe("ask");
  });

  it("is the widest mode, and a ceiling never widens", () => {
    expect(narrowestMode("bypass", "auto")).toBe("auto");
    expect(narrowestMode("bypass", null)).toBe("bypass");
    expect(narrowestMode("auto", "bypass")).toBe("auto");
    expect(narrowestMode("bypass", "read_only")).toBe("read_only");
    expect(parseToolMode("bypass")).toBe("bypass");
    expect(parseToolMode("later")).toBeUndefined();
  });

  it("is on no menu: nobody picks it from a list", () => {
    expect(TOOL_MODES).toEqual(["off", "read_only", "ask", "auto"]);
  });

  it("is never the default level a profile names", () => {
    expect(toAgentProfile({ tool_modes: { default: "bypass" } }).toolModes.default).toBe("ask");
    expect(toAgentProfile({ tool_modes: { default: "bypass", ceiling: "bypass", max: "bypass" } }).toolModes).toMatchObject({ ceiling: null, max: "bypass" });
  });
});

describe("the client announces what it can do", () => {
  it("announces nothing until told to, and then on every request", async () => {
    const { seen, fetch } = recorder();
    const transport = new FadenstackTransport({ serverUrl: "https://faden.test", fetch });
    await transport.get(transport.gateway("v1/features"));
    transport.announce(...BYPASS_SUPPORTS);
    await transport.get(transport.gateway("v1/features"));
    await transport.post(transport.api("api/x"), {});
    await (await transport.open(() => ({ method: "GET", url: transport.gateway("v1/x") }))).text();

    expect(seen.map((r) => r.headers.get(CLIENT_SUPPORTS_HEADER))).toEqual([null, "tool_mode.bypass, bypass.step_up", "tool_mode.bypass, bypass.step_up", "tool_mode.bypass, bypass.step_up"]);
    expect(transport.announced).toEqual(["tool_mode.bypass", "bypass.step_up"]);
  });

  it("takes only feature names", () => {
    const transport = new FadenstackTransport({ serverUrl: "https://faden.test" });
    expect(() => transport.announce("Not a name, really")).toThrow(TypeError);
    expect(() => transport.announce("a\r\nX-Injected: 1")).toThrow(TypeError);
  });

  it("does not announce the flow by itself: a plain client sends no header", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }] });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    await client.agent!.getProfile();
    expect(gateway.requests.filter((r) => r.headers[CLIENT_SUPPORTS_HEADER.toLowerCase()] !== undefined)).toEqual([]);
  });
});

describe("the second sign-in", () => {
  const started = (origin: string) => ({
    step_up_code: "code", user_code: "BCDF-GHJK", verification_uri: `${origin}/step-up`,
    verification_uri_complete: `${origin}/step-up#code=BCDF-GHJK`, expires_in: 600, interval: 1,
  });
  const agent = (body: unknown) => new FadenstackClient({ serverUrl: "https://faden.test", agent: "docs", fetch: recorder(body, 201).fetch }).agent!;

  it("starts on the API's own origin", async () => {
    expect(await agent(started("https://faden.test")).startStepUp(60, "x/1")).toMatchObject({ stepUpCode: "code", userCode: "BCDF-GHJK", interval: 1 });
  });

  it.each(["https://evil.test", "https://faden.test:8443", "http://faden.test", "https://faden.test.evil.test", "https://faden.test@evil.test",
    "javascript:alert(1)", "not a url", "//faden.test", "https://user:pw@faden.test"])("refuses a page at %s", async (origin) => {
    const body = origin === "//faden.test" || origin === "not a url" || origin.startsWith("javascript") || origin.includes("@faden.test")
      ? { ...started("https://faden.test"), verification_uri_complete: origin } : started(origin);
    await expect(agent(body).startStepUp(60)).rejects.toThrow(FadenstackError);
    await expect(agent(body).startStepUp(60)).rejects.toThrow("origin changed");
  });

  it("reads the poll's RFC 8628 answers, slow_down with its interval", async () => {
    const poll = (body: unknown, status: number) => new FadenstackClient({ serverUrl: "https://faden.test", agent: "docs", fetch: recorder(body, status).fetch }).agent!.pollStepUp("code");
    expect(await poll({ error: "slow_down", interval: 7 }, 400)).toEqual({ proof: null, error: "slow_down", interval: 7 });
    expect(await poll({ error: "authorization_pending" }, 400)).toEqual({ proof: null, error: "authorization_pending", interval: null });
    expect(await poll({ proof: "p", expires_in: 290, signed_in_at: "2026-11-12T10:00:00Z", method: "password" }, 200))
      .toEqual({ proof: { proof: "p", expiresIn: 290, signedInAt: "2026-11-12T10:00:00Z", method: "password" }, error: null, interval: null });
    await expect(poll({ error: "later_error" }, 400)).rejects.toThrow();
  });
});
