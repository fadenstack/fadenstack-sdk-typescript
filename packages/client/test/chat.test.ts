import { describe, expect, it } from "vitest";

import {
  FadenApiError,
  FadenClient,
  FadenRateLimitedError,
  FadenStreamError,
  StaticTokenProvider,
  type ChatUpdate,
} from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

async function signedIn(gateway: FakeGateway, agent = "test-agent") {
  const { client, tokens } = FadenClient.forAgent({ serverUrl: gateway.serverUrl, agent, fetch: gateway.fetch });
  const login = await gateway.fetch(`${gateway.serverUrl}/api/auth/jwt/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=user%40example.com&password=secret",
  });
  await tokens.signIn(((await login.json()) as { access_token: string }).access_token, "Test device");
  return client;
}

async function collect(updates: AsyncIterable<ChatUpdate>): Promise<ChatUpdate[]> {
  const out: ChatUpdate[] = [];
  for await (const u of updates) out.push(u);
  return out;
}

describe("FadenChatClient.stream", () => {
  it("streams reasoning, text, whole tool calls, usage and the finish", async () => {
    const gateway = new FakeGateway({
      model: () => ({ reasoning: "Let me look.", text: "Reading page 7.", toolCalls: [{ name: "read_page", arguments: { page: 7 } }] }),
    });
    const client = await signedIn(gateway);
    const updates = await collect(client.chat.stream([{ role: "user", content: "What is on page 7?" }], {
      tools: [{ name: "read_page", parameters: { type: "object", properties: { page: { type: "integer" } } } }],
    }));
    const text = updates.filter((u) => u.type === "text").map((u) => (u as { text: string }).text).join("");
    const reasoning = updates.filter((u) => u.type === "reasoning").map((u) => (u as { text: string }).text).join("");
    expect(reasoning).toBe("Let me look.");
    expect(text).toBe("Reading page 7.");
    const calls = updates.find((u) => u.type === "tool_calls");
    expect(calls).toMatchObject({ calls: [{ name: "read_page", arguments: { page: 7 }, argumentsJson: '{"page":7}' }] });
    expect(updates.at(-2)).toMatchObject({ type: "finish", reason: "tool_calls" });
    expect(updates.at(-1)).toMatchObject({ type: "usage" });
  });

  it("sends the agent route, the tool mode, the events header and the conversation", async () => {
    const gateway = new FakeGateway();
    const client = await signedIn(gateway);
    await collect(client.chat.stream([{ role: "user", content: "Hi" }], { toolMode: "auto", conversationId: "c1", turnId: "t1" }));
    const request = gateway.requests.find((r) => r.path.endsWith("/chat/completions"))!;
    expect(request.path).toBe("/v1/agents/test-agent/chat/completions");
    expect(request.headers["x-faden-tool-mode"]).toBe("auto");
    expect(request.headers["x-faden-events"]).toBe("ag-ui");
    expect(request.headers["x-faden-conversation-id"]).toBe("c1");
    expect(request.headers["x-faden-turn-id"]).toBe("t1");
    expect(request.body).toMatchObject({ model: "agent", stream: true, stream_options: { include_usage: true } });
  });

  it("hands over the gateway's events in order", async () => {
    const gateway = new FakeGateway({
      model: () => ({ events: [{ type: "CUSTOM", name: "faden.pii", value: { entities: { PERSON: 2 } } }], text: "ok" }),
    });
    const client = await signedIn(gateway);
    const updates = await collect(client.chat.stream([{ role: "user", content: "Hi" }]));
    expect(updates[0]).toMatchObject({ type: "event", event: { type: "CUSTOM", name: "faden.pii" } });
  });

  it("returns a refused prompt as a refusal, not an error", async () => {
    const gateway = new FakeGateway({ model: () => ({ refuse: { stage: "input", message: "No customer data here." } }) });
    const client = await signedIn(gateway);
    const updates = await collect(client.chat.stream([{ role: "user", content: "secret" }]));
    expect(updates).toEqual([
      { type: "refused", notice: expect.objectContaining({ outcome: "prompt_blocked", stage: "input", message: "No customer data here." }) },
      { type: "finish", reason: "content_filter" },
    ]);
  });

  it("returns a stopped answer as a refusal and a content_filter finish", async () => {
    const gateway = new FakeGateway({ model: () => ({ text: "Partial", refuse: { stage: "output", message: "Stopped." } }) });
    const client = await signedIn(gateway);
    const updates = await collect(client.chat.stream([{ role: "user", content: "x" }]));
    expect(updates.find((u) => u.type === "refused")).toMatchObject({ notice: { outcome: "response_blocked", message: "Stopped." } });
    expect(updates.find((u) => u.type === "finish")).toMatchObject({ reason: "content_filter" });
  });

  it("throws a stream error when the answer breaks off", async () => {
    const gateway = new FakeGateway({ model: () => ({ text: "Half", streamError: { message: "Upstream went away.", code: "upstream_error" } }) });
    const client = await signedIn(gateway);
    await expect(collect(client.chat.stream([{ role: "user", content: "x" }]))).rejects.toThrowError(FadenStreamError);
  });

  it("throws a typed error for a rate limit, with its wait", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "test-agent", contract: [{ name: "read_page", risk: "read" }] }],
      model: () => ({ rateLimit: { retryAfterS: 7 } }),
    });
    const client = await signedIn(gateway);
    const limited = await collect(client.chat.stream([{ role: "user", content: "x" }])).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(FadenRateLimitedError);
    expect((limited as FadenRateLimitedError).retryAfterMs).toBe(7000);
  });

  it("is answered without a tool the contract does not list: the gateway holds it back", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "test-agent", contract: [{ name: "read_page", risk: "read" }] }],
      model: () => ({ text: "ok" }),
    });
    const client = await signedIn(gateway);
    const updates = await collect(client.chat.stream([{ role: "user", content: "x" }], { tools: [{ name: "read_page" }, { name: "delete_page" }] }));
    expect(updates.some((u) => u.type === "text")).toBe(true);
    expect(gateway.modelCalls[0]!.tools.map((t) => t.name)).toEqual(["read_page"]);
    expect(gateway.heldTools).toEqual(["delete_page"]);
  });
});

describe("FadenChatClient.complete", () => {
  it("returns the whole answer with its tool calls", async () => {
    const gateway = new FakeGateway({ model: () => ({ text: "Done.", toolCalls: [{ name: "f", arguments: "{bad" }] }) });
    const client = await signedIn(gateway);
    const answer = await client.chat.complete([{ role: "user", content: "x" }], { tools: [{ name: "f" }] });
    expect(answer.text).toBe("Done.");
    expect(answer.finishReason).toBe("tool_calls");
    expect(answer.toolCalls[0]).toMatchObject({ name: "f", arguments: undefined });
    expect(answer.toolCalls[0]!.argumentsError).toBeTruthy();
  });

  it("returns a refused prompt as a refusal", async () => {
    const gateway = new FakeGateway({ model: () => ({ refuse: { stage: "input", message: "No." } }) });
    const client = await signedIn(gateway);
    const answer = await client.chat.complete([{ role: "user", content: "x" }]);
    expect(answer.refused).toMatchObject({ outcome: "prompt_blocked", message: "No." });
  });

  it("needs a model on the plain routes", async () => {
    const client = new FadenClient({ serverUrl: "https://faden.test", credentials: new StaticTokenProvider("t") });
    await expect(client.chat.complete([{ role: "user", content: "x" }])).rejects.toThrow("model");
  });
});

describe("FadenClient options", () => {
  it("refuses http unless allowed", () => {
    expect(() => new FadenClient({ serverUrl: "http://faden.test" })).toThrow("https");
    expect(new FadenClient({ serverUrl: "http://localhost:8000", allowInsecureHttp: true }).transport.serverUrl.href)
      .toBe("http://localhost:8000/");
  });

  it("keeps a path in the server URL", () => {
    const client = new FadenClient({ serverUrl: "https://host.example/faden", agent: "a b" });
    expect(client.chat.endpoint.href).toBe("https://host.example/faden/v1/agents/a%20b/chat/completions");
  });
});
