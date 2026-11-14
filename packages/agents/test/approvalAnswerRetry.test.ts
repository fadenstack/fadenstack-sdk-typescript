import { describe, expect, it } from "vitest";

import {
  FadenstackApiError, FadenstackClient, FadenstackUnreachableError, loginWithPassword, type FadenstackLogger, type FetchLike, type LogEvent,
} from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";

/**
 * The client's half of the lost-decline release gate (14 Nov): an answer to a gateway's approval that gets no word back is
 * sent once more with the same body, which a gateway with `approvals.idempotent` (core 0.7.1 rc17) takes once. Port of the
 * .NET ApprovalAnswerRetryTests (e5c00bb); the fake gateway here really waits for the answer, so a test that loses or
 * refuses an answer lets the repeat reach it where .NET's canned script needs no answer.
 */
const IDEMPOTENT = ["approvals.idempotent"];

interface Run {
  gateway: FakeGateway;
  agent: FadenstackAgent;
  /** The body of each approval answer the agent sent, in order. */
  answers: string[];
  events: LogEvent[];
}

/**
 * The agent over a fetch that does what `first` says to the first answer and what `second` says to the second (a function
 * that returns undefined lets the fake have it), and passes everything else on.
 */
async function build(
  features: readonly string[],
  first: (request: Request, signal: AbortSignal | undefined) => Promise<Response> | undefined,
  second: (request: Request, signal: AbortSignal | undefined) => Promise<Response> | undefined = () => undefined,
): Promise<Run> {
  const gateway = new FakeGateway({
    agents: [{ slug: "docs" }],
    features,
    model: () => ({
      gatewayTool: { name: "mcp.github.comment", approval: { message: "The tool mode asks.", rule: true, toolClass: "write", timeoutS: 3 } },
      text: "No comment then.",
    }),
  });
  const answers: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input instanceof URL ? input.href : input, init);
    if (request.method === "POST" && /\/approvals\/[^/]+$/.test(new URL(request.url).pathname)) {
      answers.push(await request.clone().text());
      const handled = (answers.length === 1 ? first : answers.length === 2 ? second : () => undefined)(request, init?.signal ?? undefined);
      if (handled) return handled;
    }
    return gateway.fetch(request);
  };
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const events: LogEvent[] = [];
  const logger: FadenstackLogger = { log: (event) => { events.push(event); } };
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useLogging(logger)
    .useApprovals(async () => ({ approved: false })).build();
  agent.approvalAnswerTimeoutMs = 300;
  return { gateway, agent, answers, events };
}

/**
 * A first answer that never gets a word back (the lost decline): ended only by the SDK's short wait. It listens to the signal the
 * SDK passed to fetch, not to the Request's own, which undici follows through a weak reference that a collection can drop.
 */
const hang = (_request: Request, signal: AbortSignal | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => { reject(signal.reason); }); });

const send = async (run: Run) => (await run.agent.startSession()).send("Comment.");
const failed = (work: () => Promise<unknown>) => work().then(() => undefined, (e: unknown) => e);
const status = (code: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } }));

describe("an approval answer that gets no word back", () => {
  it("a lost answer is sent once more with the same body", async () => {
    const run = await build(IDEMPOTENT, hang);

    const result = await send(run);

    expect(result.text).toBe("No comment then.");
    expect(run.answers).toHaveLength(2); // the hung first try never reached the fake; the retry did
    expect(run.answers[1]).toBe(run.answers[0]);
    expect(JSON.parse(run.answers[0]!).approved).toBe(false);
    expect(run.gateway.approvals).toHaveLength(1);
    const retried = run.events.filter((e) => e.eventId === 2053);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ category: "Fadenstack.Agents", eventName: "ApprovalAnswerRetried", level: "warning" });
    expect(retried[0]!.message).toMatch(/^An approval answer got no word back \(\w+\); it is sent once more$/);
    expect(JSON.stringify(retried)).not.toContain("approved"); // the kind of failure, never the answer
  });

  it.each([0, 502, 503, 504])("no word back (%i) is retried and the body is the same", async (code) => {
    const run = await build(IDEMPOTENT, () => (code === 0 ? Promise.reject(new TypeError("connection reset")) : status(code)));

    const result = await send(run);

    expect(result.text).toBe("No comment then.");
    expect(run.answers).toHaveLength(2);
    expect(run.answers[1]).toBe(run.answers[0]);
    expect(run.gateway.approvals).toHaveLength(1);
  });

  it("an older gateway answers the repeat of a taken answer 404, which counts as taken", async () => {
    // No approvals.idempotent. The fake takes the repeat (so the stream goes on) and the answer says 404, as the old one does.
    const run = await build([], hang, async (request) => {
      await FakeGatewayPass.through(request);
      return status(404, { error: { message: "No such approval", code: "approval_not_found" } });
    });
    FakeGatewayPass.use(run.gateway);

    const result = await send(run);

    expect(result.text).toBe("No comment then.");
  });

  it("with idempotent answers a 404 on the repeat is an error", async () => {
    const run = await build(IDEMPOTENT, hang, async (request) => {
      await FakeGatewayPass.through(request);
      return status(404, { error: { message: "No such approval", code: "approval_not_found" } });
    });
    FakeGatewayPass.use(run.gateway);

    const error = await failed(() => send(run));

    expect(error).toBeInstanceOf(FadenstackApiError);
    expect((error as FadenstackApiError).status).toBe(404);
  });

  it("a 409 is never sent again", async () => {
    const run = await build(IDEMPOTENT, () => status(409, { error: { message: "Already answered", code: "approval_already_answered" } }));

    const error = await failed(() => send(run));

    expect(error).toBeInstanceOf(FadenstackApiError);
    expect((error as FadenstackApiError).code).toBe("approval_already_answered");
    expect(run.answers).toHaveLength(1);
  });

  it("any other refusal is not sent again either", async () => {
    const run = await build(IDEMPOTENT, () => status(422, { error: { message: "No", code: "invalid" } }));
    expect(await failed(() => send(run))).toBeInstanceOf(FadenstackApiError);
    expect(run.answers).toHaveLength(1);
  });

  it("an answer that is taken is sent once", async () => {
    const run = await build([], () => undefined);

    await send(run);

    expect(run.answers).toHaveLength(1);
    expect(run.events.filter((e) => e.eventId === 2053)).toEqual([]);
  });

  it("two tries without a word end the turn with the error", async () => {
    const run = await build(IDEMPOTENT, () => Promise.reject(new TypeError("down")), () => Promise.reject(new TypeError("still down")));

    const error = await failed(() => send(run));

    expect(error).toBeInstanceOf(FadenstackUnreachableError);
    expect(run.answers).toHaveLength(2);
  });

  it("two hung tries end the turn too, after two short waits", async () => {
    const run = await build(IDEMPOTENT, hang, hang);

    const error = await failed(() => send(run));

    expect(error).toBeDefined();
    expect(run.answers).toHaveLength(2);
  });

  it("a stopped turn is not retried", async () => {
    const run = await build(IDEMPOTENT, hang);
    const stop = new AbortController();
    const session = await run.agent.startSession();
    const waiting = session.send("Comment.", { signal: stop.signal }).then(() => undefined, (e: unknown) => e);
    for (let i = 0; i < 200 && run.answers.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(run.answers).toHaveLength(1);

    stop.abort();
    await waiting;

    expect(run.answers).toHaveLength(1);
  });
});

/** Lets a test hand a request to the fake it was built with, from inside the `second` callback. */
const FakeGatewayPass = (() => {
  let current: FakeGateway | undefined;
  return {
    use(gateway: FakeGateway): void { current = gateway; },
    async through(request: Request): Promise<Response> { return current!.fetch(request); },
  };
})();
