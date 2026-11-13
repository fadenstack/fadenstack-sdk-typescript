import { describe, expect, it } from "vitest";

import {
  AgentPairing,
  AgentTokenProvider,
  FadenstackClient,
  FadenstackPairingAgentError,
  FadenstackPairingDeniedError,
  FadenstackPairingExpiredError,
  FadenstackPairingUnsupportedError,
  FadenstackRateLimitedError,
  FadenstackSignInRequiredError,
  MemoryTokenStore,
  type FadenstackLogger,
  type FetchLike,
  type LogEvent,
  type PairingProgress,
  type PairingStart,
  type TokenSet,
} from "@fadenstack/client";
import { FakeGateway, type FakeGatewayOptions } from "@fadenstack/testing";

// Sign-in by pairing (.NET PairingTests): the code, the polling rules, the saved sign-in, and signing out.

const PAIRING = "PAIRING-SECRET-9f3a";
const AGENT = "docs-assistant";
const SERVER = "https://faden.test";
const APP = { name: "Browser assistant", version: "1.2.3", os: "Chrome 140" };

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const startAnswer = (interval = 5) => ({
  pairing_code: PAIRING, user_code: "BDWP-HTQX", verification_uri: `${SERVER}/pair`, verification_uri_complete: `${SERVER}/pair#code=BDWP-HTQX`,
  expires_in: 600, interval,
});
const tokens = (withUser = true) => ({
  access_token: "access-SECRET-1", token_type: "bearer", expires_in: 600, refresh_token: "refresh-SECRET-1", refresh_expires_in: 86_400,
  device_id: "device-1", agent_id: "a-1", agent: AGENT,
  user: withUser ? { id: "aaaaaaaa-1111", email: "anna@example.com", display_name: "Anna Weber" } : null,
});
const pending = (error: string) => jsonResponse(400, { error, error_description: error });

/** A scripted server: the start answers, the polls come from a queue (a function throws as a network error), the clock moves with the waits. */
class Rig {
  now = 1_000_000;
  readonly waits: number[] = [];
  readonly requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  readonly polls: (() => Response)[] = [];
  readonly store = new MemoryTokenStore();
  startStatus = 201;
  startBody: unknown = startAnswer();

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const request = { path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: new Headers(init?.headers) };
    this.requests.push(request);
    if (url.pathname.endsWith("/pairings")) return jsonResponse(this.startStatus, this.startBody);
    const next = this.polls.shift();
    if (!next) throw new Error("no more scripted polls");
    return next();
  };

  pairing(): AgentPairing {
    return new AgentPairing({ apiUrl: SERVER, store: this.store, fetch: this.fetch, now: () => this.now,
      delay: async (ms, signal) => { signal?.throwIfAborted(); this.waits.push(ms); this.now += ms; } });
  }
  poll(...answers: (() => Response)[]): this { this.polls.push(...answers); return this; }
  get pollCount() { return this.requests.filter((r) => r.path.endsWith("/token")).length; }
}
const down = (): Response => { throw new TypeError("connection refused to 10.0.0.1"); };
const approved = () => jsonResponse(201, tokens());

describe("pairing: start", () => {
  it("sends the agent, the device and the app, and returns what to show", async () => {
    const rig = new Rig();
    const start = await rig.pairing().start(AGENT, "Browser on PC-7", APP);
    const sent = rig.requests[0]!;
    expect(rig.requests).toHaveLength(1);
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.body).toEqual({ agent: AGENT, device_label: "Browser on PC-7", client: { name: "Browser assistant", version: "1.2.3", os: "Chrome 140" } });
    expect(start.userCode).toBe("BDWP-HTQX");
    expect(start.verificationUri.href).toBe(`${SERVER}/pair`);
    expect(start.verificationUriComplete.href).toBe(`${SERVER}/pair#code=BDWP-HTQX`);
    expect(start.expiresAt).toBe(rig.now + 600_000);
    expect(start.intervalMs).toBe(5000);
  });

  it("builds the link itself when the server sends only the page, with the code in the fragment", async () => {
    const rig = new Rig();
    rig.startBody = { ...startAnswer(), verification_uri_complete: undefined };
    const start = await rig.pairing().start(AGENT, "PC", APP);
    expect(start.verificationUriComplete.href).toBe(`${SERVER}/pair#code=BDWP-HTQX`);
  });

  it("opens only the server's own origin: a page elsewhere, with a sign-in in it, or not a web address is refused", async () => {
    for (const page of ["https://evil.example/pair", "https://faden.test:8443/pair", "http://faden.test/pair", "https://user:pw@faden.test/pair", "javascript:alert(1)"]) {
      const rig = new Rig();
      rig.startBody = { ...startAnswer(), verification_uri: page, verification_uri_complete: `${page}#code=BDWP-HTQX` };
      await expect(rig.pairing().start(AGENT, "PC", APP)).rejects.toThrow(/pairing page is not on the server|not a web address/);
    }
    const rig = new Rig();
    rig.startBody = { ...startAnswer(), verification_uri: "/pair", verification_uri_complete: "/pair#code=BDWP-HTQX" }; // relative: the server's own
    expect((await rig.pairing().start(AGENT, "PC", APP)).verificationUri.href).toBe(`${SERVER}/pair`);
  });

  it("keeps the pairing code out of the start object, its text and JSON", async () => {
    const rig = new Rig().poll(approved);
    const pairing = rig.pairing();
    const start = await pairing.start(AGENT, "PC", APP);
    await pairing.wait(start);
    expect(`${start}`).not.toContain(PAIRING);
    expect(JSON.stringify(start)).not.toContain(PAIRING);
    expect(Object.values(start).map(String).join("|")).not.toContain(PAIRING);
    expect(Object.getOwnPropertyNames(start).join("|")).not.toContain("pairing");
    // what the poll sends is the code, in the body only
    expect(rig.requests.filter((r) => r.path.endsWith("/token")).map((r) => r.body)).toEqual([{ pairing_code: PAIRING }]);
  });

  it("reads 404 and 405 as a server that is too old", async () => {
    for (const status of [404, 405]) {
      const rig = new Rig();
      rig.startStatus = status;
      await expect(rig.pairing().start(AGENT, "PC", APP)).rejects.toBeInstanceOf(FadenstackPairingUnsupportedError);
    }
  });

  it("types the other failures: 429, an answer nobody can read", async () => {
    const limited = new Rig();
    limited.startStatus = 429;
    limited.startBody = { detail: { code: "too_many_requests", message: "Later." } };
    await expect(limited.pairing().start(AGENT, "PC", APP)).rejects.toBeInstanceOf(FadenstackRateLimitedError);
    const odd = new Rig();
    odd.startBody = { pairing_code: "", user_code: "X" };
    await expect(odd.pairing().start(AGENT, "PC", APP)).rejects.toThrow(/not understood/);
  });

  it("refuses plain http to another machine", () => {
    expect(() => new AgentPairing({ apiUrl: "http://faden.example" })).toThrow();
    expect(() => new AgentPairing({ apiUrl: "http://localhost:8000" })).not.toThrow();
    expect(() => new AgentPairing({ apiUrl: "http://faden.example", allowInsecureHttp: true })).not.toThrow();
  });
});

describe("pairing: wait", () => {
  it("polls until approval, then saves the tokens and who signed in where a provider finds them", async () => {
    const rig = new Rig().poll(() => pending("authorization_pending"), () => pending("authorization_pending"), approved);
    const pairing = rig.pairing();
    const progress: PairingProgress[] = [];
    const result = await pairing.wait(await pairing.start(AGENT, "PC", APP), { onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ agentSlug: AGENT, deviceId: "device-1", signedInUser: { id: "aaaaaaaa-1111", email: "anna@example.com", displayName: "Anna Weber" } });
    expect(rig.waits).toEqual([5000, 5000, 5000]);
    expect(progress.map((p) => p.state)).toEqual(["waiting", "waiting", "waiting"]);
    expect(progress[0]!.timeLeftMs).toBe(600_000);
    const provider = new AgentTokenProvider({ apiUrl: SERVER, agent: AGENT, store: rig.store, now: () => rig.now });
    expect(provider.signedInUser).toBeUndefined(); // not loaded yet
    expect(await provider.isSignedIn()).toBe(true);
    expect(await provider.getAccessToken()).toBe("access-SECRET-1");
    expect(await provider.getSignedInUser()).toEqual(result.signedInUser);
    expect(provider.signedInUser?.email).toBe("anna@example.com");
  });

  it("the server may leave out the user", async () => {
    const rig = new Rig().poll(() => jsonResponse(201, tokens(false)));
    const pairing = rig.pairing();
    const result = await pairing.wait(await pairing.start(AGENT, "PC", APP));
    expect(result.signedInUser).toBeUndefined();
    expect("signedInUser" in result).toBe(false);
  });

  it("slow_down adds five seconds for every later poll", async () => {
    const rig = new Rig().poll(() => pending("authorization_pending"), () => pending("slow_down"), () => pending("authorization_pending"),
      () => pending("slow_down"), approved);
    const progress: PairingProgress[] = [];
    const pairing = rig.pairing();
    await pairing.wait(await pairing.start(AGENT, "PC", APP), { onProgress: (p) => progress.push(p) });
    expect(rig.waits).toEqual([5000, 5000, 10_000, 10_000, 15_000]);
    expect(progress.map((p) => p.state)).toEqual(["waiting", "waiting", "slowed_down", "waiting", "slowed_down"]);
    expect(progress.at(-1)!.intervalMs).toBe(15_000);
  });

  it("a 429 on a poll is slow_down too, and a longer Retry-After wins", async () => {
    const rig = new Rig().poll(() => jsonResponse(429, { detail: "slow" }, { "retry-after": "40" }), approved);
    const pairing = rig.pairing();
    await pairing.wait(await pairing.start(AGENT, "PC", APP));
    expect(rig.waits).toEqual([5000, 40_000]);
  });

  it("backs off 5, 10, 20, 30, 30 seconds when the server cannot be reached, and recovers", async () => {
    const rig = new Rig().poll(down, down, down, down, down, approved);
    const progress: PairingProgress[] = [];
    const pairing = rig.pairing();
    const result = await pairing.wait(await pairing.start(AGENT, "PC", APP), { onProgress: (p) => progress.push(p) });
    expect(rig.waits).toEqual([5000, 5000, 10_000, 20_000, 30_000, 30_000]);
    expect(progress.filter((p) => p.state === "retrying")).toHaveLength(5);
    expect(result.agentSlug).toBe(AGENT);
  });

  it("retries a server error like a network error, and the backoff starts over after an answer", async () => {
    const rig = new Rig().poll(() => jsonResponse(503, "busy"), () => jsonResponse(502, "bad"), () => pending("authorization_pending"),
      () => jsonResponse(500, "boom"), approved);
    const pairing = rig.pairing();
    await pairing.wait(await pairing.start(AGENT, "PC", APP));
    expect(rig.waits).toEqual([5000, 5000, 10_000, 5000, 5000]);
  });

  it("does not outlive the pairing when the network stays down", async () => {
    const rig = new Rig();
    rig.polls.push(...Array.from({ length: 100 }, () => down));
    const pairing = rig.pairing();
    await expect(pairing.wait(await pairing.start(AGENT, "PC", APP))).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
    expect(rig.now).toBeGreaterThanOrEqual(1_000_000 + 600_000);
  });

  it("an expired code, one the server no longer knows, and a clock past the expiry all say expired", async () => {
    for (const error of ["expired_token", "invalid_grant"]) {
      const rig = new Rig().poll(() => pending(error));
      const pairing = rig.pairing();
      await expect(pairing.wait(await pairing.start(AGENT, "PC", APP))).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
    }
    const rig = new Rig();
    const pairing = rig.pairing();
    const start = await pairing.start(AGENT, "PC", APP);
    rig.now += 700_000;
    await expect(pairing.wait(start)).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
    expect(rig.pollCount).toBe(0); // without asking
  });

  it("a denial throws denied and saves nothing", async () => {
    const rig = new Rig().poll(() => pending("access_denied"));
    const pairing = rig.pairing();
    await expect(pairing.wait(await pairing.start(AGENT, "PC", APP))).rejects.toBeInstanceOf(FadenstackPairingDeniedError);
    expect(await rig.store.load(AgentTokenProvider.storeKey(SERVER, AGENT))).toBeUndefined();
  });

  it("a server that loses the routes is reported as unsupported", async () => {
    for (const status of [404, 405]) {
      const rig = new Rig().poll(() => jsonResponse(status, { detail: "x" }));
      const pairing = rig.pairing();
      await expect(pairing.wait(await pairing.start(AGENT, "PC", APP))).rejects.toBeInstanceOf(FadenstackPairingUnsupportedError);
    }
  });

  it("cancelling stops the wait and is not mistaken for a network error, mid-poll too", async () => {
    const rig = new Rig();
    const pairing = rig.pairing();
    const start = await pairing.start(AGENT, "PC", APP);
    const stop = new AbortController();
    rig.polls.push(() => { stop.abort(new DOMException("stopped", "AbortError")); return pending("authorization_pending"); });
    await expect(pairing.wait(start, { signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(rig.pollCount).toBe(1);
    const slow = new AgentPairing({ apiUrl: SERVER, fetch: (_i, init) => new Promise((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }), delay: async () => undefined });
    const again = new AbortController();
    const startFetch: FetchLike = async () => jsonResponse(201, startAnswer());
    const s = await new AgentPairing({ apiUrl: SERVER, fetch: startFetch }).start(AGENT, "PC", APP);
    const waiting = slow.wait(s, { signal: again.signal });
    again.abort(new DOMException("stopped", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the code, the tokens and the person out of what it logs and reports", async () => {
    const events: LogEvent[] = [];
    const logger: FadenstackLogger = { log: (e) => { events.push(e); } };
    const rig = new Rig().poll(down, () => pending("slow_down"), () => pending("authorization_pending"), approved);
    const pairing = new AgentPairing({ apiUrl: SERVER, store: rig.store, fetch: rig.fetch, now: () => rig.now, logger,
      delay: async (ms) => { rig.waits.push(ms); rig.now += ms; } });
    const start = await pairing.start(AGENT, "PC", APP);
    const seen: string[] = [];
    await pairing.wait(start, { onProgress: (p) => seen.push(JSON.stringify(p)) });
    expect(seen.join("|")).not.toMatch(/SECRET|BDWP|anna@|10\.0\.0\.1/);
    expect(events.map((e) => [e.eventId, e.message])).toEqual([
      [1030, "Pairing for agent docs-assistant started; it is valid for 600 s"],
      [1032, "Pairing for agent docs-assistant: the server could not be reached (network); trying again in 5 s"],
      [1031, "Pairing for agent docs-assistant: the server asked to slow down (10 s)"],
      [1033, "Pairing for agent docs-assistant ended: signed in"],
    ]);
    expect(events.every((e) => e.category === "Fadenstack.Client")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/SECRET|BDWP|anna@|10\.0\.0\.1/);
  });
});

describe("pairing against the fake server", () => {
  const options = (extra: FakeGatewayOptions = {}): FakeGatewayOptions => ({ pairing: true, principal: true, agents: [{ slug: "docs" }], ...extra });

  async function pair(gateway: FakeGateway, extra: { interval?: number } = {}) {
    const store = new MemoryTokenStore();
    const pairing = new AgentPairing({ apiUrl: gateway.serverUrl, store, fetch: gateway.fetch, delay: async () => undefined, ...extra });
    const start = await pairing.start("docs", "Browser on PC", APP);
    return { pairing, store, start };
  }

  it("signs a person in: approved in the console, the app chats with the tokens it got", async () => {
    const gateway = new FakeGateway(options({ model: () => ({ text: "Hello." }) }));
    const { pairing, store, start } = await pair(gateway);
    expect(gateway.pairings).toHaveLength(1);
    expect(gateway.pairings[0]).toMatchObject({ agent: "docs", deviceLabel: "Browser on PC", client: APP, state: "pending" });
    const waiting = pairing.wait(start);
    gateway.approvePairing("user@example.com");
    const result = await waiting;
    expect(result.signedInUser?.email).toBe("user@example.com");
    expect(gateway.signIns.map((s) => [s.agent, s.label, s.userId])).toEqual([["docs", "Browser on PC", "user-1"]]);
    const provider = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, fetch: gateway.fetch });
    const client = new FadenstackClient({ serverUrl: gateway.serverUrl, agent: "docs", credentials: provider, fetch: gateway.fetch });
    expect((await client.agent!.getProfile()).slug).toBe("docs");
    // the pairing is consumed
    expect(gateway.pairings[0]!.state).toBe("consumed");
  });

  it("a provider that already said 'not signed in' sees the pairing's sign-in once it is saved", async () => {
    const gateway = new FakeGateway(options());
    const { pairing, store, start } = await pair(gateway);
    const provider = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, fetch: gateway.fetch });
    expect(await provider.isSignedIn()).toBe(false);
    const waiting = pairing.wait(start);
    gateway.approvePairing("user@example.com");
    await waiting;
    // The app keeps its one provider (the browser extension built a new agent to get around this before).
    expect(await provider.isSignedIn()).toBe(true);
    expect(await provider.getAccessToken()).toBeTruthy();
  });

  it("a denial and an expiry end the wait", async () => {
    const gateway = new FakeGateway(options());
    const a = await pair(gateway);
    const denied = a.pairing.wait(a.start);
    gateway.denyPairing();
    await expect(denied).rejects.toBeInstanceOf(FadenstackPairingDeniedError);
    const b = await pair(gateway);
    const expired = b.pairing.wait(b.start);
    gateway.expirePairings();
    await expect(expired).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
  });

  it("an older server (404, and core 0.7.0's 405) is too old; the default fake is one", async () => {
    for (const pairing of [undefined, { unsupported: 404 as const }, { unsupported: 405 as const }]) {
      const gateway = new FakeGateway({ agents: [{ slug: "docs" }], ...(pairing ? { pairing } : {}) });
      const p = new AgentPairing({ apiUrl: gateway.serverUrl, fetch: gateway.fetch });
      await expect(p.start("docs", "PC", APP)).rejects.toBeInstanceOf(FadenstackPairingUnsupportedError);
    }
  });

  it("refuses a server whose page lies on another origin, and a limit is a rate-limit error", async () => {
    const hostile = new FakeGateway(options({ pairing: { pageOrigin: "https://evil.example" } }));
    await expect(new AgentPairing({ apiUrl: hostile.serverUrl, fetch: hostile.fetch }).start("docs", "PC", APP)).rejects.toThrow(/not on the server/);
    const limited = new FakeGateway(options({ pairing: { startLimit: 1 } }));
    const p = new AgentPairing({ apiUrl: limited.serverUrl, fetch: limited.fetch });
    await p.start("docs", "PC", APP);
    await expect(p.start("docs", "PC", APP)).rejects.toBeInstanceOf(FadenstackRateLimitedError);
  });

  it("slow_down from the fake server stretches the waits", async () => {
    const gateway = new FakeGateway(options({ pairing: { slowDown: [2] } }));
    const waits: number[] = [];
    const store = new MemoryTokenStore();
    const pairing = new AgentPairing({ apiUrl: gateway.serverUrl, store, fetch: gateway.fetch, delay: async (ms) => {
      waits.push(ms);
      if (waits.length === 3) gateway.approvePairing();
    } });
    await pairing.wait(await pairing.start("docs", "PC", APP));
    expect(waits).toEqual([5000, 5000, 10_000]);
  });
});

describe("pairing: several agents", () => {
  const slugs = (n: number) => Array.from({ length: n }, (_, i) => `agent-${i + 1}`);
  const options = (extra: Record<string, unknown> = {}): FakeGatewayOptions =>
    ({ pairing: true, principal: true, agents: [{ slug: "word" }, { slug: "excel" }, { slug: "outlook" }], ...extra }) as FakeGatewayOptions;
  const make = (gateway: FakeGateway) => {
    const store = new MemoryTokenStore();
    const pairing = new AgentPairing({ apiUrl: gateway.serverUrl, store, fetch: gateway.fetch, delay: async () => undefined });
    return { store, pairing };
  };
  const provider = (gateway: FakeGateway, store: MemoryTokenStore, agent: string) =>
    new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent, store, fetch: gateway.fetch });

  it("refuses more than 8 agents, a repeat or an empty name before any request", async () => {
    const rig = new Rig();
    const pairing = rig.pairing();
    await expect(pairing.start("agent-1", "PC", APP, { agents: slugs(8).slice(1).concat("agent-9") })).rejects.toBeInstanceOf(RangeError);
    await expect(pairing.start("agent-1", "PC", APP, { agents: ["b", "b"] })).rejects.toBeInstanceOf(TypeError);
    await expect(pairing.start("agent-1", "PC", APP, { agents: ["agent-1"] })).rejects.toBeInstanceOf(TypeError);
    await expect(pairing.start("agent-1", "PC", APP, { agents: [""] })).rejects.toBeInstanceOf(TypeError);
    expect(rig.requests).toHaveLength(0);
    // exactly 8 in all is fine
    await pairing.start("agent-1", "PC", APP, { agents: slugs(8).slice(1) });
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]!.body["agents"]).toEqual(slugs(8));
  });

  it("sends agents (the first included) only for several agents, and none for one", async () => {
    const rig = new Rig();
    await rig.pairing().start(AGENT, "PC", APP);
    await rig.pairing().start(AGENT, "PC", APP, { agents: [] });
    await rig.pairing().start(AGENT, "PC", APP, new AbortController().signal);
    for (const r of rig.requests) expect(Object.keys(r.body)).toEqual(["agent", "device_label", "client"]);
    await rig.pairing().start(AGENT, "PC", APP, { agents: ["b", "c"] });
    expect(rig.requests[3]!.body["agent"]).toBe(AGENT);
    expect(rig.requests[3]!.body["agents"]).toEqual([AGENT, "b", "c"]);
  });

  it("sends the agent on the token request only for an agent other than the first", async () => {
    const rig = new Rig();
    rig.startBody = { ...startAnswer(), agents: [AGENT, "b"] };
    rig.poll(approved, () => jsonResponse(201, { ...tokens(), agent: "b" }));
    const pairing = rig.pairing();
    const start = await pairing.start(AGENT, "PC", APP, { agents: ["b"] });
    expect(start.agents).toEqual([AGENT, "b"]);
    await pairing.wait(start);
    await pairing.redeem(start, "b");
    const bodies = rig.requests.filter((r) => r.path.endsWith("/token")).map((r) => r.body);
    expect(bodies).toEqual([{ pairing_code: PAIRING }, { pairing_code: PAIRING, agent: "b" }]);
  });

  it("wait with an agent waits for the approval and returns that agent's tokens, saved for that agent", async () => {
    const gateway = new FakeGateway(options());
    const { pairing, store } = make(gateway);
    const start = await pairing.start("word", "Office on PC", APP, { agents: ["excel", "outlook"] });
    expect(start.agents).toEqual(["word", "excel", "outlook"]);
    expect(start.ignoredAgents).toEqual([]);
    expect(gateway.pairings[0]!.agents).toEqual(["word", "excel", "outlook"]);
    const waiting = pairing.wait(start, { agent: "excel" });
    gateway.approvePairing("user@example.com");
    expect((await waiting).agentSlug).toBe("excel");
    expect(await provider(gateway, store, "excel").isSignedIn()).toBe(true);
    expect(await provider(gateway, store, "word").isSignedIn()).toBe(false);
    expect(gateway.signIns.map((s) => s.agent)).toEqual(["excel"]);
  });

  it("redeem collects each other agent once after one approval; the pairing is consumed after the last", async () => {
    const gateway = new FakeGateway(options());
    const { pairing, store } = make(gateway);
    const start = await pairing.start("word", "Office on PC", APP, { agents: ["excel", "outlook"] });
    const waiting = pairing.wait(start);
    gateway.approvePairing("user@example.com");
    expect((await waiting).agentSlug).toBe("word");
    expect(gateway.pairings[0]!.state).toBe("approved");
    expect((await pairing.redeem(start, "excel")).agentSlug).toBe("excel");
    expect(gateway.pairings[0]!.state).toBe("approved");
    expect((await pairing.redeem(start, "outlook")).agentSlug).toBe("outlook");
    expect(gateway.pairings[0]!.state).toBe("consumed");
    for (const agent of ["word", "excel", "outlook"]) expect(await provider(gateway, store, agent).isSignedIn()).toBe(true);
    expect(gateway.signIns.map((s) => [s.agent, s.userId, s.label])).toEqual(
      ["word", "excel", "outlook"].map((a) => [a, "user-1", "Office on PC"]));
    // each sign-in is its own device
    expect(new Set((await Promise.all(["word", "excel", "outlook"].map((a) => provider(gateway, store, a).getAccessToken()))).map(String)).size).toBe(3);
  });

  it("redeeming an agent twice, or one the person did not get, is a typed error saying not approved or already redeemed", async () => {
    const gateway = new FakeGateway(options());
    const { pairing } = make(gateway);
    const start = await pairing.start("word", "PC", APP, { agents: ["excel", "outlook"] });
    gateway.approvePairing("user@example.com", undefined, ["outlook"]);
    await pairing.redeem(start, "excel");
    const again = await pairing.redeem(start, "excel").catch((e: unknown) => e);
    expect(again).toBeInstanceOf(FadenstackPairingAgentError);
    expect(again).toMatchObject({ agent: "excel", reason: "not_approved_or_redeemed" });
    expect((again as Error).message).toMatch(/did not approve it, or it was collected already/);
    const refused = await pairing.redeem(start, "outlook").catch((e: unknown) => e);
    expect(refused).toMatchObject({ agent: "outlook", reason: "not_approved_or_redeemed" });
    expect(gateway.signIns.map((s) => s.agent)).toEqual(["excel"]);
  });

  it("an agent the pairing does not name is refused by the server as invalid_grant, not issued", async () => {
    const gateway = new FakeGateway(options());
    const { pairing } = make(gateway);
    const start = await pairing.start("word", "PC", APP, { agents: ["excel"] });
    gateway.approvePairing();
    Object.defineProperty(start, "agents", { value: ["word", "excel", "outlook"] }); // claims more than the server stored
    await expect(pairing.redeem(start, "outlook")).rejects.toMatchObject({ reason: "not_approved_or_redeemed" });
    expect(gateway.signIns).toEqual([]);
  });

  it("redeeming before the approval says pending; a denial and an expiry keep their errors", async () => {
    const gateway = new FakeGateway(options());
    const { pairing } = make(gateway);
    const start = await pairing.start("word", "PC", APP, { agents: ["excel"] });
    await expect(pairing.redeem(start, "excel")).rejects.toMatchObject({ reason: "pending" });
    gateway.denyPairing();
    await expect(pairing.redeem(start, "excel")).rejects.toBeInstanceOf(FadenstackPairingDeniedError);
    const other = await pairing.start("word", "PC", APP, { agents: ["excel"] });
    gateway.expirePairings();
    await expect(pairing.redeem(other, "excel")).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
  });

  it("a server that ignores agents stores only the first: its tokens come, the others are named as left and refused locally", async () => {
    const gateway = new FakeGateway(options({ pairing: { ignoreAgents: true } }));
    const { pairing, store } = make(gateway);
    const start = await pairing.start("word", "PC", APP, { agents: ["excel", "outlook"] });
    expect(start.agents).toEqual([]);
    expect(start.ignoredAgents).toEqual(["excel", "outlook"]);
    expect(gateway.pairings[0]!.agents).toEqual(["word"]);
    const waiting = pairing.wait(start);
    gateway.approvePairing();
    const result = await waiting;
    expect(result.agentSlug).toBe("word");
    expect(result.ignoredAgents).toEqual(["excel", "outlook"]);
    expect(await provider(gateway, store, "word").isSignedIn()).toBe(true);
    const before = gateway.pairings[0]!.polls;
    const refused = await pairing.redeem(start, "excel").catch((e: unknown) => e);
    expect(refused).toMatchObject({ agent: "excel", reason: "not_offered" });
    await expect(pairing.wait(start, { agent: "outlook" })).rejects.toMatchObject({ reason: "not_offered" });
    expect(gateway.pairings[0]!.polls).toBe(before); // nothing was sent
  });

  it("a single agent against the fake server still works with no agents on the wire", async () => {
    const gateway = new FakeGateway(options());
    const { pairing } = make(gateway);
    const start = await pairing.start("word", "PC", APP);
    expect(start.agents).toEqual(["word"]);
    const waiting = pairing.wait(start);
    gateway.approvePairing();
    expect((await waiting).agentSlug).toBe("word");
    expect(gateway.pairings[0]).toMatchObject({ agents: ["word"], redeemed: ["word"], state: "consumed" });
  });
});

describe("signing out", () => {
  async function signedIn(revoke: (init: RequestInit | undefined) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const store = new MemoryTokenStore();
    const set: TokenSet = { accessToken: "access-SECRET-1", accessExpiresAt: Date.now() + 600_000, refreshToken: "refresh-SECRET-1",
      refreshExpiresAt: Date.now() + 86_400_000, deviceId: "d", agentId: "a", agent: AGENT, user: { id: "u", email: "anna@example.com" } };
    await store.save(AgentTokenProvider.storeKey(SERVER, AGENT), set);
    const provider = new AgentTokenProvider({ apiUrl: SERVER, agent: AGENT, store, fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return revoke(init);
    } });
    expect(await provider.isSignedIn()).toBe(true);
    return { provider, store, calls };
  }

  it("revokes the refresh token on the server and deletes the tokens", async () => {
    const { provider, store, calls } = await signedIn(() => new Response(null, { status: 204 }));
    expect((await provider.getSignedInUser())?.email).toBe("anna@example.com");
    await provider.signOut();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SERVER}/api/agent-tokens/revoke`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ refresh_token: "refresh-SECRET-1" });
    expect(new Headers(calls[0]!.init!.headers).get("authorization")).toBeNull();
    expect(await store.load(AgentTokenProvider.storeKey(SERVER, AGENT))).toBeUndefined();
    expect(provider.signedInUser).toBeUndefined();
    expect(await provider.isSignedIn()).toBe(false);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(FadenstackSignInRequiredError);
  });

  it.each(["network", "refused"])("deletes the tokens even when the revoke fails (%s)", async (how) => {
    const { provider, store, calls } = await signedIn(() => {
      if (how === "network") throw new TypeError("unreachable");
      return new Response("boom", { status: 500 });
    });
    await provider.signOut();
    expect(calls).toHaveLength(1);
    expect(await store.load(AgentTokenProvider.storeKey(SERVER, AGENT))).toBeUndefined();
    expect(await provider.isSignedIn()).toBe(false);
  });

  it("without a sign-in does nothing and asks nobody", async () => {
    const calls: string[] = [];
    const provider = new AgentTokenProvider({ apiUrl: SERVER, agent: AGENT, fetch: async (input) => { calls.push(String(input)); return new Response(null, { status: 204 }); } });
    await provider.signOut();
    expect(calls).toEqual([]);
  });

  it("ends the sign-in at the fake server", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }], pairing: true });
    const store = new MemoryTokenStore();
    const pairing = new AgentPairing({ apiUrl: gateway.serverUrl, store, fetch: gateway.fetch, delay: async () => undefined });
    const waiting = pairing.wait(await pairing.start("docs", "PC", APP));
    gateway.approvePairing();
    await waiting;
    const provider = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, fetch: gateway.fetch });
    expect(gateway.signIns[0]!.revoked).toBe(false);
    await provider.signOut();
    expect(gateway.signIns[0]!.revoked).toBe(true);
  });

  it("a renewal keeps who signed in", async () => {
    let now = 1_000_000;
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }], pairing: true, now: () => now });
    const store = new MemoryTokenStore();
    const pairing = new AgentPairing({ apiUrl: gateway.serverUrl, store, fetch: gateway.fetch, now: () => now, delay: async () => undefined });
    const waiting = pairing.wait(await pairing.start("docs", "PC", APP));
    gateway.approvePairing();
    await waiting;
    // a server answer for the renewal that names nobody
    const provider = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, now: () => now, fetch: async (input, init) => {
      const response = await gateway.fetch(input, init);
      if (!String(input).endsWith("/refresh")) return response;
      const body = (await response.json()) as Record<string, unknown>;
      delete body["user"];
      return jsonResponse(200, body);
    } });
    now += 700_000; // the access token ran out
    await provider.getAccessToken();
    expect((await store.load(AgentTokenProvider.storeKey(gateway.serverUrl, "docs")))!.user?.email).toBe("user@example.com");
  });

  it("a token answer's user without an e-mail is none, and a stored set without a user still loads", async () => {
    const rig = new Rig().poll(() => jsonResponse(201, { ...tokens(), user: { id: "x" } }));
    const pairing = rig.pairing();
    const result = await pairing.wait(await pairing.start(AGENT, "PC", APP));
    expect(result.signedInUser).toBeUndefined();
    const loaded = await rig.store.load(AgentTokenProvider.storeKey(SERVER, AGENT));
    expect(loaded && "user" in loaded).toBe(false);
  });
});

export type { PairingStart };

describe("pairing: the first agent refused (sdk/51 I00 #8, I-11)", () => {
  const AGENTS = ["word-assistant", "excel-assistant", "outlook-assistant"];
  const several = () => {
    const rig = new Rig();
    rig.startBody = { ...startAnswer(), agents: AGENTS };
    return rig;
  };
  const key = (agent: string) => AgentTokenProvider.storeKey(SERVER, agent);

  it("a first agent refused while another was approved is reported refused, not expired", async () => {
    // The person approved only the second and third agents. The server answers invalid_grant for the first, as it would
    // for a code it does not know; another agent of the pairing tells the two apart.
    const rig = several().poll(() => pending("invalid_grant"), approved);
    const pairing = rig.pairing();
    const start = await pairing.start(AGENTS[0]!, "PC", APP, { agents: AGENTS.slice(1) });

    const error = await pairing.wait(start).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackPairingAgentError);
    expect((error as FadenstackPairingAgentError).agent).toBe(AGENTS[0]);
    expect((error as FadenstackPairingAgentError).reason).toBe("not_approved_or_redeemed");
    expect(await rig.store.load(key(AGENTS[0]!))).toBeUndefined();
    expect(await rig.store.load(key(AGENTS[1]!))).toBeDefined(); // the approved agent that told them apart is signed in
    expect(rig.requests.at(-1)?.body["agent"]).toBe(AGENTS[1]);
    expect(start.agentsLeft).toEqual([AGENTS[0], AGENTS[2]]);
  });

  it("the first agent and every other answering invalid_grant is a code the server does not know", async () => {
    const rig = several().poll(() => pending("invalid_grant"), () => pending("invalid_grant"), () => pending("invalid_grant"));
    const pairing = rig.pairing();
    const start = await pairing.start(AGENTS[0]!, "PC", APP, { agents: AGENTS.slice(1) });

    await expect(pairing.wait(start)).rejects.toBeInstanceOf(FadenstackPairingExpiredError);

    expect(start.agentsLeft).toEqual(AGENTS);
    for (const agent of AGENTS) expect(await rig.store.load(key(agent))).toBeUndefined();
  });

  it("another agent waited for and not approved is reported for that agent, not as expired", async () => {
    const rig = several().poll(() => pending("invalid_grant"));
    const pairing = rig.pairing();
    const start = await pairing.start(AGENTS[0]!, "PC", APP, { agents: AGENTS.slice(1) });

    const error = await pairing.wait(start, { agent: AGENTS[2]! }).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackPairingAgentError);
    expect((error as FadenstackPairingAgentError).agent).toBe(AGENTS[2]);
  });

  it("an older server that stored one agent reads invalid_grant as before and asks no other agent", async () => {
    const rig = new Rig().poll(() => pending("invalid_grant"));
    const pairing = rig.pairing();
    const start = await pairing.start(AGENTS[0]!, "PC", APP, { agents: AGENTS.slice(1) });

    await expect(pairing.wait(start)).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
    expect(rig.pollCount).toBe(1);
    expect(start.agentsLeft).toEqual(AGENTS); // the ones the server ignored are still to be signed in
  });
});
