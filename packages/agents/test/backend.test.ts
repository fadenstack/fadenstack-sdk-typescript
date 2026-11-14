import { describe, expect, it } from "vitest";

import {
  BYPASS_SUPPORTS,
  FadenstackApiError,
  FadenstackAuthenticationError,
  FadenstackClient,
  FadenstackUnreachableError,
  type FadenstackLogger,
} from "@fadenstack/client";
import { FadenstackAgent, STEP_UP_REQUIRED } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup } from "./helpers.js";

const hostClient = (gateway: FakeGateway, extra: { logger?: FadenstackLogger } = {}) =>
  FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch, ...extra }).client;

describe("the server backend and a host's own client", () => {
  it("announces the Bypass flow on the client it was given only where the app opens a second sign-in", () => {
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }] });
    const plain = hostClient(gateway);
    FadenstackAgent.createBuilder().useClient(plain).useApprovals(() => Promise.resolve({ approved: false })).build();
    expect(plain.transport.announced).toEqual([]);

    const own = hostClient(gateway);
    const opener = { open: () => Promise.resolve(true), report: () => undefined };
    FadenstackAgent.createBuilder().useClient(own).useStepUpHandler(opener).build();
    expect(own.transport.announced).toEqual([...BYPASS_SUPPORTS]);

    // An approval handler that is one too (open and report) is enough.
    const viaApprovals = hostClient(gateway);
    FadenstackAgent.createBuilder().useClient(viaApprovals)
      .useApprovals({ ...opener, request: () => Promise.resolve({ approved: false }) }).build();
    expect(viaApprovals.transport.announced).toEqual([...BYPASS_SUPPORTS]);
  });

  it("gives the agent's logger to a client without one, and leaves the logger a client has", () => {
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }] });
    const mine: FadenstackLogger = { log: () => undefined };
    const theirs: FadenstackLogger = { log: () => undefined };
    const bare = hostClient(gateway);
    FadenstackAgent.createBuilder().useClient(bare).useLogging(mine).build();
    expect(bare.transport.logger).toBe(mine);
    const logging = hostClient(gateway, { logger: theirs });
    FadenstackAgent.createBuilder().useClient(logging).useLogging(mine).build();
    expect(logging.transport.logger).toBe(theirs);
  });

  it("does not touch the client when the build fails", () => {
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }] });
    const client = hostClient(gateway);
    const opener = { open: () => Promise.resolve(true), report: () => undefined };
    expect(() => FadenstackAgent.createBuilder().useClient(client).useAgent("other").useStepUpHandler(opener).build()).toThrow(/one agent per client/);
    expect(client.transport.announced).toEqual([]);
  });
});

describe("the server's errors pass through the backend unchanged", () => {
  const grantsOn = { grants: { approvals: { standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"] } } };

  const fixture = async (options: object = grantsOn) => {
    const s = await setup({ ...options, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    await s.agent.start();
    return s;
  };
  const failure = async (call: Promise<unknown>) => call.then(() => undefined, (error: unknown) => error);

  it("the step-up challenge arrives as an authentication error with its code (Bypass retries on it)", async () => {
    const s = await fixture();
    const error = await failure(s.agent.backend.createGrant({ kind: "bypass", minutes: 10 }, { conversationId: "c1" }));
    expect(error).toBeInstanceOf(FadenstackAuthenticationError);
    expect((error as FadenstackAuthenticationError).code).toBe(STEP_UP_REQUIRED);
  });

  it("404 on a grant is an API error with its status (the grant lifecycle reads it)", async () => {
    const s = await fixture();
    const error = await failure(s.agent.backend.getGrant("g-none"));
    expect(error).toBeInstanceOf(FadenstackApiError);
    expect((error as FadenstackApiError).status).toBe(404);
    expect(await failure(s.agent.backend.resumeGrant("g-none"))).toMatchObject({ status: 404 });
  });

  it("an unreachable server is a FadenstackUnreachableError with the platform's error inside", async () => {
    const down = new TypeError("fetch failed");
    const s = await fixture();
    const client = s.client as unknown as { transport: { fetch: unknown } };
    (client.transport as { fetch: unknown }).fetch = () => Promise.reject(down);
    for (const call of [s.agent.backend.listGrants(), s.agent.backend.startStepUp(5)]) {
      const error = await failure(call);
      expect(error).toBeInstanceOf(FadenstackUnreachableError);
      expect((error as FadenstackUnreachableError).cause).toBe(down);
    }
  });
});
