import { describe, expect, it } from "vitest";

import {
  AgentTokenProvider,
  FadenApiError,
  FadenClient,
  FadenPermissionError,
  FadenSignInRequiredError,
  FadenUnreachableError,
  MemoryTokenStore,
  createAgent,
  loginWithPassword,
} from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

/** A gateway and a client on one clock the test moves. */
function setup(options: ConstructorParameters<typeof FakeGateway>[0] = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const gateway = new FakeGateway({ ...options, now: clock });
  const store = new MemoryTokenStore();
  const tokens = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "test-agent", store, fetch: gateway.fetch, now: clock });
  const client = new FadenClient({ serverUrl: gateway.serverUrl, agent: "test-agent", credentials: tokens, fetch: gateway.fetch });
  const tick = (ms: number) => (now += ms);
  return { gateway, client, tokens, store, tick, now: clock };
}

describe("sign-in", () => {
  it("logs in with a password and signs in to the agent with a device label", async () => {
    const { gateway, tokens } = setup();
    const login = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch });
    const set = await tokens.signIn(login, "Chrome on PC-7");
    expect(set.deviceId).toMatch(/^device-/);
    expect(await tokens.isSignedIn()).toBe(true);
    expect(gateway.signIns[0]).toMatchObject({ agent: "test-agent", label: "Chrome on PC-7" });
  });

  it("says plainly when the password is wrong", async () => {
    const { gateway } = setup();
    const error = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "nope", fetch: gateway.fetch })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenApiError);
    expect((error as Error).message).toBe("The e-mail or password is not right.");
  });

  it("tells no answer at all apart from a refusal", async () => {
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    const error = await loginWithPassword({ apiUrl: "https://faden.example.com", email: "u@x", password: "p", fetch: offline })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenUnreachableError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("says when the address answers with a web page instead of the API", async () => {
    const page = () => Promise.resolve(new Response("<!doctype html><title>Console</title>", { status: 200, headers: { "content-type": "text/html" } }));
    const error = await loginWithPassword({ apiUrl: "https://faden.example.com/admin", email: "u@x", password: "p", fetch: page })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenApiError);
    expect((error as FadenApiError).code).toBe("not_fadenstack");
  });

  it("says there is no such agent (404), apart from no access (403)", async () => {
    const { gateway, tokens } = setup();
    const login = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch });
    const other = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "no-such-agent", store: new MemoryTokenStore(), fetch: gateway.fetch });
    const error = await other.signIn(login).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenApiError);
    expect(error).not.toBeInstanceOf(FadenPermissionError);
    expect((error as FadenApiError).status).toBe(404);
    expect(await tokens.isSignedIn()).toBe(false);
  });

  it("creates the agent from the app's definition for someone with agents:create, then signs in to it", async () => {
    const { gateway, tokens } = setup({
      agents: [],
      users: [{ email: "admin@example.com", password: "p", createsAgents: true, agents: [] }, { email: "u@x", password: "p" }],
    });
    const definition = { slug: "test-agent", name: "Test agent", version: { host_tool_contract: [{ name: "read_page", risk: "read" }] } };

    const user = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "u@x", password: "p", fetch: gateway.fetch });
    const refused = await createAgent({ apiUrl: gateway.serverUrl, loginToken: user, definition, fetch: gateway.fetch }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FadenPermissionError);

    const admin = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "admin@example.com", password: "p", fetch: gateway.fetch });
    const created = await createAgent({ apiUrl: gateway.serverUrl, loginToken: admin, definition, fetch: gateway.fetch });
    expect(created).toMatchObject({ slug: "test-agent", status: "draft" });
    expect(gateway.createdAgents).toEqual([{ slug: "test-agent", by: "admin@example.com", body: definition }]);
    await tokens.signIn(admin);
    expect(await tokens.isSignedIn()).toBe(true);
    const again = await createAgent({ apiUrl: gateway.serverUrl, loginToken: admin, definition, fetch: gateway.fetch }).catch((e: unknown) => e);
    expect((again as FadenApiError).status).toBe(409);
  });

  it("is refused without a grant", async () => {
    const { gateway, tokens } = setup({ users: [{ email: "u@x", password: "p", agents: [] }] });
    const login = await loginWithPassword({ apiUrl: gateway.serverUrl, email: "u@x", password: "p", fetch: gateway.fetch });
    await expect(tokens.signIn(login)).rejects.toBeInstanceOf(FadenPermissionError);
  });

  it("requires a sign-in before the first request", async () => {
    const { client } = setup();
    await expect(client.agent!.getProfile()).rejects.toBeInstanceOf(FadenSignInRequiredError);
  });
});

describe("tokens", () => {
  async function signedIn(options: ConstructorParameters<typeof FakeGateway>[0] = {}) {
    const s = setup(options);
    const login = await loginWithPassword({ apiUrl: s.gateway.serverUrl, email: "user@example.com", password: "secret", fetch: s.gateway.fetch });
    await s.tokens.signIn(login);
    return s;
  }

  it("renews the access token before it expires, with one refresh for every caller", async () => {
    const s = await signedIn({ accessTtlSeconds: 60 });
    s.tick(45_000); // within 30 s of the end
    await Promise.all([s.client.agent!.getProfile(), s.client.agent!.getProfile(), s.client.agent!.getProfile()]);
    expect(s.gateway.requests.filter((r) => r.path === "/api/agent-tokens/refresh")).toHaveLength(1);
  });

  it("retries once with a fresh token when the server refuses the token (401)", async () => {
    const s = await signedIn();
    s.gateway.expireAccessTokens();
    const profile = await s.client.agent!.getProfile();
    expect(profile.slug).toBe("test-agent");
    expect(s.gateway.requests.filter((r) => r.path === "/api/agent-tokens/refresh")).toHaveLength(1);
  });

  it("ends the sign-in on this device when the server revoked it", async () => {
    const s = await signedIn();
    s.gateway.revoke();
    s.gateway.expireAccessTokens();
    await expect(s.client.agent!.getProfile()).rejects.toBeInstanceOf(FadenSignInRequiredError);
    expect(await s.tokens.isSignedIn()).toBe(false);
    expect(await s.store.load(AgentTokenProvider.storeKey(s.gateway.serverUrl, "test-agent"))).toBeUndefined();
  });

  it("asks for a new sign-in once the refresh token expired", async () => {
    const s = await signedIn({ accessTtlSeconds: 60, refreshTtlSeconds: 120 });
    s.tick(121_000);
    await expect(s.client.agent!.getProfile()).rejects.toBeInstanceOf(FadenSignInRequiredError);
  });

  it("keeps the sign-in in its store for the next run", async () => {
    const s = await signedIn();
    const again = new AgentTokenProvider({ apiUrl: s.gateway.serverUrl, agent: "test-agent", store: s.store, fetch: s.gateway.fetch, now: s.now });
    expect(await again.isSignedIn()).toBe(true);
    expect(await again.getAccessToken()).toMatch(/^access\./);
  });
});
