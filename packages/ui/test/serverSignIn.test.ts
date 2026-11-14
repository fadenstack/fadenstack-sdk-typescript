import { MachinePolicy, PolicyAccess } from "@fadenstack/agents";
import {
  FadenstackBadCredentialsError,
  FadenstackHttpsRequiredError,
  FadenstackPairingExpiredError,
  FadenstackPairingDeniedError,
  FadenstackPairingPageElsewhereError,
  FadenstackPairingUnsupportedError,
  MemoryTokenStore,
  type FetchLike,
} from "@fadenstack/client";
import { AgentAccess, createPairingTicket, createServerSignIn, type ServerSignIn } from "@fadenstack/ui";
import { describe, expect, it } from "vitest";

// The wizard's default server side (sdk/51 F15): `createServerSignIn` over the SDK's health check, pairing and password login,
// against a scripted fetch. .NET: ServerSignInTests. The pairing fakes follow the client's pairing tests.

const PAIRING = "PAIRING-SECRET-9f3a";
const USER_CODE = "BDWP-HTQX";
const SERVER = new URL("https://faden.test");
const APP = { name: "Office", version: "1.0", os: "Windows 11" };
const SUITE = ["word-assistant", "excel-assistant", "outlook-assistant"];

const keyOf = (agent: string): string => `https://faden.test/|${agent}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokens = (agent: string) => ({
  access_token: `access-SECRET-${agent}`, token_type: "bearer", expires_in: 600, refresh_token: `refresh-SECRET-${agent}`, refresh_expires_in: 86_400,
  device_id: "11111111-2222-3333-4444-555555555555", agent_id: `id-${agent}`, agent,
  user: { id: "aaaaaaaa-1111-2222-3333-444444444444", email: "anna@example.com", display_name: "Anna Weber" },
});
const invalidGrant = (): Response => json(400, { code: "invalid_grant" });

interface Recorded {
  method: string;
  path: string;
  body: string;
  headers: Headers;
}

const jsonOf = (r: Recorded): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;

class Rig {
  readonly requests: Recorded[] = [];
  readonly routes = new Map<string, (request: Recorded) => Response>();
  readonly store = new MemoryTokenStore();
  readonly sign: ServerSignIn;
  /** What the token route answers for the agent in the request (the first agent when it names none). */
  token: (agent: string) => Response = (agent) => json(201, tokens(agent));

  readonly fetch: FetchLike = (input, init) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const request: Recorded = { method: init?.method ?? "GET", path: url.pathname, body: String(init?.body ?? ""), headers: new Headers(init?.headers) };
    this.requests.push(request);
    const route = this.routes.get(`${request.method} ${request.path}`);
    if (!route) return Promise.resolve(json(404, { detail: "not found" }));
    return Promise.resolve(route(request));
  };

  /** @param storedAgents What the start answer says the server stored; undefined for a server that does not know `agents`. */
  constructor(storedAgents: string[] | undefined, agents: string[] = SUITE, policy?: MachinePolicy, delay?: (ms: number, signal?: AbortSignal) => Promise<void>) {
    this.routes.set("POST /api/agent-tokens/pairings", () => json(201, {
      pairing_code: PAIRING, user_code: USER_CODE, verification_uri: "https://faden.test/pair",
      verification_uri_complete: `https://faden.test/pair?code=${USER_CODE}`, expires_in: 600, interval: 1,
      ...(storedAgents ? { agents: storedAgents } : {}),
    }));
    this.routes.set("POST /api/agent-tokens/pairings/token", (r) => this.token(typeof jsonOf(r)["agent"] === "string" ? (jsonOf(r)["agent"] as string) : agents[0]!));
    this.sign = createServerSignIn({
      tokenStore: this.store, agents, deviceLabel: "Word assistant on PC-7", client: APP, policy, fetch: this.fetch,
      timing: { delay: delay ?? ((_ms, signal) => { signal?.throwIfAborted(); return Promise.resolve(); }) },
    });
  }

  get starts(): Recorded[] {
    return this.requests.filter((r) => r.path.endsWith("/pairings"));
  }

  get tokenRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.endsWith("/pairings/token"));
  }

  health(): void {
    this.routes.set("GET /api/health", () => json(200, { status: "ok" }));
  }
}

const signal = (): AbortSignal => new AbortController().signal;
const noRetry = (): ((retrying: boolean) => void) => () => undefined;

describe("createServerSignIn: the constructor and the health check", () => {
  it("needs a token store, agents and a client", () => {
    const base = { tokenStore: new MemoryTokenStore(), agents: SUITE, deviceLabel: "PC", client: APP };
    expect(() => createServerSignIn({ ...base, tokenStore: undefined as never })).toThrow(TypeError);
    expect(() => createServerSignIn({ ...base, agents: [] })).toThrow(TypeError);
    expect(() => createServerSignIn({ ...base, client: undefined as never })).toThrow(TypeError);
  });

  it("the health check asks the server through the given fetch", async () => {
    const rig = new Rig(SUITE);
    rig.health();
    await rig.sign.check(SERVER, signal());
    expect(rig.requests.map((r) => r.path)).toEqual(["/api/health"]);
  });

  it("plain http goes only to the http server the machine policy names", async () => {
    const corp = new URL("http://corp.internal:8080");
    const policy = new MachinePolicy({ server: corp, standalone: PolicyAccess.Forbidden });
    const named = new Rig(SUITE, SUITE, policy);
    named.health();
    await named.sign.check(corp, signal());
    expect(named.requests).toHaveLength(1);
    // The request goes; the fake's sign-in page is on another address, which the SDK refuses after the answer.
    await expect(named.sign.start(corp, signal())).rejects.toBeInstanceOf(FadenstackPairingPageElsewhereError);
    expect(named.starts).toHaveLength(1);

    const other = new Rig(SUITE, SUITE, policy);
    await expect(other.sign.check(new URL("http://other.internal:8080"), signal())).rejects.toBeInstanceOf(FadenstackHttpsRequiredError);
    await expect(other.sign.start(new URL("http://other.internal:8080"), signal())).rejects.toBeInstanceOf(FadenstackHttpsRequiredError);
    expect(other.requests).toEqual([]);

    const none = new Rig(SUITE);
    await expect(none.sign.check(corp, signal())).rejects.toBeInstanceOf(FadenstackHttpsRequiredError);
    expect(none.requests).toEqual([]);
  });
});

describe("createServerSignIn: start", () => {
  it("gives a ticket with the code, the page and the agents", async () => {
    const rig = new Rig(SUITE);
    const ticket = await rig.sign.start(SERVER, signal());
    expect(ticket.userCode).toBe(USER_CODE);
    expect(ticket.verificationUri.href).toBe("https://faden.test/pair");
    expect(ticket.verificationUriComplete.href).toBe(`https://faden.test/pair?code=${USER_CODE}`);
    expect(ticket.agents).toEqual(SUITE);
    expect(ticket.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(ticket.expiresAt).toBeLessThan(Date.now() + 11 * 60_000);
    expect(ticket.handle).toBeDefined();
    expect(rig.starts).toHaveLength(1);
    const sent = jsonOf(rig.starts[0]!);
    expect(sent["agent"]).toBe(SUITE[0]);
    expect(sent["agents"]).toEqual(SUITE);
    expect(sent["device_label"]).toBe("Word assistant on PC-7");
    expect((sent["client"] as Record<string, string>)["name"]).toBe("Office");
  });

  it("a ticket never exposes the pairing code and its text has no user code", async () => {
    const rig = new Rig(SUITE);
    const ticket = await rig.sign.start(SERVER, signal());
    for (const text of [String(ticket), JSON.stringify(ticket), String(ticket.handle), JSON.stringify(ticket.handle)]) {
      expect(text).not.toContain(PAIRING);
    }
    expect(String(ticket)).not.toContain(USER_CODE);
    expect(JSON.stringify(ticket)).not.toContain(USER_CODE);
    for (const [name, value] of Object.entries(ticket)) {
      if (name !== "userCode" && value !== null && value !== undefined) expect(String(value)).not.toContain(PAIRING);
    }
  });

  it("a server error at the start is a typed error, not a ticket", async () => {
    const rig = new Rig(SUITE);
    rig.routes.set("POST /api/agent-tokens/pairings", () => json(404, { detail: "no pairing here" }));
    await expect(rig.sign.start(SERVER, signal())).rejects.toBeInstanceOf(FadenstackPairingUnsupportedError);
  });

  it("a ticket that is not this sign-in's is refused", async () => {
    const rig = new Rig(SUITE);
    const strange = createPairingTicket({ userCode: "X", verificationUri: SERVER, verificationUriComplete: SERVER, expiresAt: Date.now(), agents: SUITE, handle: {} });
    await expect(rig.sign.wait(strange, noRetry(), signal())).rejects.toBeInstanceOf(TypeError);
    await expect(rig.sign.redeem(strange, SUITE[1]!, signal())).rejects.toBeInstanceOf(TypeError);
  });
});

describe("createServerSignIn: wait", () => {
  it("collects the main agent and says who signed in", async () => {
    const rig = new Rig(SUITE);
    const ticket = await rig.sign.start(SERVER, signal());
    const approval = await rig.sign.wait(ticket, noRetry(), signal());
    expect(approval.agents).toEqual([{ agent: SUITE[0], access: AgentAccess.Approved }]);
    expect(approval.person?.email).toBe("anna@example.com");
    expect((await rig.store.load(keyOf(SUITE[0]!)))?.accessToken).toBe(`access-SECRET-${SUITE[0]}`);
    expect(await rig.store.load(keyOf(SUITE[1]!))).toBeUndefined(); // the others are collected by redeem
  });

  it("reports true to the progress on a retry", async () => {
    const rig = new Rig(SUITE);
    rig.routes.set("POST /api/agent-tokens/pairings/token", () => { throw new TypeError("connection refused"); });
    const ticket = await rig.sign.start(SERVER, signal());
    const stop = new AbortController();
    const seen: boolean[] = [];
    await expect(rig.sign.wait(ticket, (retrying) => {
      seen.push(retrying);
      if (retrying) stop.abort();
    }, stop.signal)).rejects.toBeDefined();
    expect(seen).toEqual([false, true]); // waiting at the start, then retrying after the failed poll
  });

  it("a main agent that was not approved among several is refused and the collected one is approved", async () => {
    // The person approved the second agent only. The first answers invalid_grant, as for a code the server does not know;
    // another agent of the pairing tells the two apart. The agents that are still to collect are left out.
    const rig = new Rig(SUITE);
    rig.token = (agent) => (agent === SUITE[0] ? invalidGrant() : json(201, tokens(agent)));
    const ticket = await rig.sign.start(SERVER, signal());
    const approval = await rig.sign.wait(ticket, noRetry(), signal());
    expect(approval.agents).toEqual([{ agent: SUITE[0], access: AgentAccess.Refused }, { agent: SUITE[1], access: AgentAccess.Approved }]);
    expect(approval.person).toBeUndefined();
    expect(await rig.store.load(keyOf(SUITE[0]!))).toBeUndefined();
    expect(await rig.store.load(keyOf(SUITE[1]!))).toBeDefined();
  });

  it("a code the server does not know is expired and not a refusal", async () => {
    const rig = new Rig(SUITE);
    rig.token = () => invalidGrant();
    const ticket = await rig.sign.start(SERVER, signal());
    await expect(rig.sign.wait(ticket, noRetry(), signal())).rejects.toBeInstanceOf(FadenstackPairingExpiredError);
  });

  it("a denied pairing is a denied error", async () => {
    const rig = new Rig(SUITE);
    rig.token = () => json(400, { code: "access_denied" });
    const ticket = await rig.sign.start(SERVER, signal());
    await expect(rig.sign.wait(ticket, noRetry(), signal())).rejects.toBeInstanceOf(FadenstackPairingDeniedError);
  });
});

describe("createServerSignIn: redeem", () => {
  it("collects another agent and a refused one is refused", async () => {
    const rig = new Rig(SUITE);
    rig.token = (agent) => (agent === SUITE[2] ? invalidGrant() : json(201, tokens(agent)));
    const ticket = await rig.sign.start(SERVER, signal());
    await rig.sign.wait(ticket, noRetry(), signal());
    const second = await rig.sign.redeem(ticket, SUITE[1]!, signal());
    const third = await rig.sign.redeem(ticket, SUITE[2]!, signal());
    expect(second).toEqual({ agent: SUITE[1], access: AgentAccess.Approved });
    expect(third).toEqual({ agent: SUITE[2], access: AgentAccess.Refused });
    expect(await rig.store.load(keyOf(SUITE[1]!))).toBeDefined();
    expect(await rig.store.load(keyOf(SUITE[2]!))).toBeUndefined();
  });

  it("on an older server gives Left without a request", async () => {
    const rig = new Rig(undefined); // the start answer has no `agents`: one agent per pairing
    const ticket = await rig.sign.start(SERVER, signal());
    const before = rig.requests.length;
    const second = await rig.sign.redeem(ticket, SUITE[1]!, signal());
    expect(second).toEqual({ agent: SUITE[1], access: AgentAccess.Left });
    expect(rig.requests).toHaveLength(before);
    expect(rig.tokenRequests).toEqual([]);
    expect(await rig.store.load(keyOf(SUITE[1]!))).toBeUndefined();
  });
});

describe("createServerSignIn: the password sign-in", () => {
  function loginRoutes(rig: Rig, agentToken?: (agent: string) => Response): void {
    rig.routes.set("POST /api/auth/jwt/login", () => json(200, { access_token: "login-jwt", token_type: "bearer" }));
    rig.routes.set("POST /api/agent-tokens", (r) => {
      const agent = jsonOf(r)["agent"] as string;
      return agentToken ? agentToken(agent) : json(201, tokens(agent));
    });
  }

  it("signs in each agent and a 403 agent is refused", async () => {
    const rig = new Rig(SUITE);
    loginRoutes(rig, (agent) => (agent === SUITE[1]
      ? json(403, { code: "agent_not_granted", detail: "no grant" })
      : json(201, tokens(agent))));
    const approval = await rig.sign.signInWithPassword(SERVER, "anna@example.com", "s3cret", signal());
    expect(approval.agents).toEqual([
      { agent: SUITE[0], access: AgentAccess.Approved }, { agent: SUITE[1], access: AgentAccess.Refused },
      { agent: SUITE[2], access: AgentAccess.Approved },
    ]);
    expect(approval.person?.email).toBe("anna@example.com");
    expect(await rig.store.load(keyOf(SUITE[0]!))).toBeDefined();
    expect(await rig.store.load(keyOf(SUITE[1]!))).toBeUndefined();
    expect(await rig.store.load(keyOf(SUITE[2]!))).toBeDefined();
    const login = rig.requests.filter((r) => r.path === "/api/auth/jwt/login");
    expect(login).toHaveLength(1);
    expect(login[0]!.body).toBe("username=anna%40example.com&password=s3cret");
    const signIns = rig.requests.filter((r) => r.path === "/api/agent-tokens");
    expect(signIns.map((r) => jsonOf(r)["agent"])).toEqual(SUITE);
    for (const r of signIns) {
      expect(r.headers.get("authorization")).toBe("Bearer login-jwt");
      expect(jsonOf(r)["device_label"]).toBe("Word assistant on PC-7");
    }
  });

  it("with every agent signed in gives the first person", async () => {
    const rig = new Rig(SUITE);
    loginRoutes(rig);
    const approval = await rig.sign.signInWithPassword(SERVER, "anna@example.com", "s3cret", signal());
    expect(approval.agents.every((a) => a.access === AgentAccess.Approved)).toBe(true);
    expect(approval.agents.map((a) => a.agent)).toEqual(SUITE);
    expect(approval.person?.displayName).toBe("Anna Weber");
  });

  it("a wrong password is a bad credentials error and signs no agent in", async () => {
    const rig = new Rig(SUITE);
    rig.routes.set("POST /api/auth/jwt/login", () => json(400, { detail: "LOGIN_BAD_CREDENTIALS" }));
    const error = await rig.sign.signInWithPassword(SERVER, "anna@example.com", "wrong-SECRET", signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenstackBadCredentialsError);
    expect((error as Error).message).not.toContain("wrong-SECRET");
    expect(rig.requests.some((r) => r.path === "/api/agent-tokens")).toBe(false);
  });

  it("the password goes only over https or to this machine", async () => {
    const rig = new Rig(SUITE);
    loginRoutes(rig);
    await expect(rig.sign.signInWithPassword(new URL("http://ai.example.test"), "anna@example.com", "s3cret", signal())).rejects.toBeInstanceOf(FadenstackHttpsRequiredError);
    expect(rig.requests).toEqual([]);
  });
});

describe("createServerSignIn: a pairing that survives a closed panel (TypeScript's own)", () => {
  it("exports a ticket with the pairing code and resumes it in another sign-in, which waits and signs in", async () => {
    const first = new Rig(SUITE);
    const ticket = await first.sign.start(SERVER, signal());
    const saved = first.sign.export!(ticket)!;
    expect(saved.pairingCode).toBe(PAIRING);
    expect(saved.userCode).toBe(USER_CODE);

    const second = new Rig(SUITE);
    const again = second.sign.resume!(SERVER, JSON.parse(JSON.stringify(saved)));
    expect(again.userCode).toBe(USER_CODE);
    expect(again.agents).toEqual(SUITE);
    expect(again.expiresAt).toBe(ticket.expiresAt);
    expect(String(again)).not.toContain(PAIRING);
    const approval = await second.sign.wait(again, noRetry(), signal());
    expect(approval.agents[0]).toEqual({ agent: SUITE[0], access: AgentAccess.Approved });
    expect(second.starts).toEqual([]); // no new pairing was asked for
    expect(jsonOf(second.tokenRequests[0]!)).toEqual({ pairing_code: PAIRING });
  });

  it("refuses to export a ticket that is not its own and a saved pairing whose page is elsewhere", async () => {
    const rig = new Rig(SUITE);
    const strange = createPairingTicket({ userCode: "X", verificationUri: SERVER, verificationUriComplete: SERVER, expiresAt: Date.now(), agents: SUITE, handle: {} });
    expect(() => rig.sign.export!(strange)).toThrow(TypeError);
    const saved = rig.sign.export!(await rig.sign.start(SERVER, signal()))!;
    expect(() => rig.sign.resume!(SERVER, { ...saved, verificationUri: "https://evil.example/pair" })).toThrow(FadenstackPairingPageElsewhereError);
  });
});
