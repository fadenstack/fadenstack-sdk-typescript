import { describe, expect, it } from "vitest";

import { BYPASS_SUPPORTS, FadenstackClient, type FadenstackLogger } from "@fadenstack/client";
import { FadenstackAgent } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";

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
