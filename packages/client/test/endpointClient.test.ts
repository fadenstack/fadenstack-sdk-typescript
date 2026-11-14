import { describe, expect, it } from "vitest";

import {
  DirectChatClient,
  EndpointContextLengthError,
  EndpointDialect,
  EndpointKeyRejectedError,
  EndpointModelNotFoundError,
  EndpointNotCompatibleError,
  EndpointOriginRefusedError,
  EndpointPlainHttpRefusedError,
  EndpointUnreachableError,
  FadenstackApiError,
  FadenstackRateLimitedError,
  FadenstackStreamError,
  ServerCertificateError,
  StaticTokenProvider,
  StreamAssembler,
  endpointBase,
  endpointChatCompletions,
  endpointModels,
  endpointRoot,
  readSse,
  type ChatMessage,
  type ChatOptions,
  type ChatUpdate,
  type PlainHttpRefusal,
  type SseEvent,
  type SseLimits,
  type TokenProvider,
} from "@fadenstack/client";
import { OpenAiFake } from "@fadenstack/testing";

// sdk/51 F03, I03 commits 3 to 6: the person's own endpoint as a ChatStreamer, and its transport rules. One test for each
// of the .NET EndpointClientTests (same scenarios), plus the browser's cases.

interface MakeOptions {
  dialect?: EndpointDialect;
  key?: TokenProvider;
  lan?: boolean;
  model?: string;
}

function make(baseUrl = "http://localhost:11434/v1", options: MakeOptions = {}): { client: DirectChatClient; fake: OpenAiFake } {
  const fake = new OpenAiFake();
  const client = new DirectChatClient({
    baseUrl, model: options.model ?? "qwen3:14b", dialect: options.dialect ?? EndpointDialect.openAiCompatible,
    allowPlainHttpInLan: options.lan ?? false, fetch: fake.fetch,
    ...(options.key ? { key: options.key } : {}),
  });
  return { client, fake };
}

const hi: ChatMessage[] = [{ role: "user", content: "Hi" }];

async function collect(updates: AsyncIterable<ChatUpdate>): Promise<ChatUpdate[]> {
  const out: ChatUpdate[] = [];
  for await (const u of updates) out.push(u);
  return out;
}

async function streamed(client: DirectChatClient, options: ChatOptions = {}, messages: ChatMessage[] = hi): Promise<{ text: string; updates: ChatUpdate[] }> {
  const updates = await collect(client.stream(messages, options));
  return { text: updates.map((u) => (u.type === "text" ? u.text : "")).join(""), updates };
}

const failure = async (work: () => Promise<unknown>): Promise<unknown> => work().then(() => undefined, (e: unknown) => e);

describe("the URLs", () => {
  it.each([
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions", "http://localhost:11434/api/show"],
    ["http://localhost:11434/v1/", "http://localhost:11434/v1/chat/completions", "http://localhost:11434/api/show"],
    ["https://res.openai.azure.com/openai/v1", "https://res.openai.azure.com/openai/v1/chat/completions", "https://res.openai.azure.com/openai/api/show"],
    ["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/api/show"],
    ["http://[::1]:8000/v1", "http://[::1]:8000/v1/chat/completions", "http://[::1]:8000/api/show"],
    ["https://llm.example/proxy", "https://llm.example/proxy/chat/completions", "https://llm.example/proxy/api/show"],
  ])("a base resolves with or without a slash: %s", (baseUrl, chat, root) => {
    expect(endpointChatCompletions(baseUrl).href).toBe(chat);
    expect(endpointModels(baseUrl).href).toBe(chat.replace("chat/completions", "models"));
    expect(endpointRoot(baseUrl, "api/show").href).toBe(root);
  });

  it.each([
    "https://host/v1?api-version=1",
    "https://host/v1#x",
    "https://user:secret@host/v1",
    "ftp://host/v1",
  ])("a base with a query, fragment, user info or another scheme is refused: %s", (baseUrl) => {
    expect(() => endpointBase(baseUrl)).toThrow(TypeError);
  });
});

describe("the request", () => {
  it("carries nothing of the gateway and the endpoint's model", async () => {
    const { client, fake } = make();
    const options: ChatOptions = {
      instructions: "Ours first.\n\nThen the person's.", conversationId: "conv-1", turnId: "turn-1", toolMode: "auto", sessionId: "s-1",
      skills: ["house-style"], extra: { "faden.something": "x", user: "someone@example.com", top_k: 40, model: "evil", messages: [] },
    };

    const { text } = await streamed(client, options, [{ role: "user", content: "Hi", name: "Ana" }]);

    expect(text).toBe("Hello.");
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url.href).toBe("http://localhost:11434/v1/chat/completions");
    expect(Object.keys(request.headers).filter((h) => h.startsWith("x-faden"))).toEqual([]);
    expect(request.header("authorization")).toBeUndefined();
    const body = request.json();
    expect(body["model"]).toBe("qwen3:14b");
    for (const field of ["session_id", "skills", "user", "faden.something", "watermark", "watermarking"]) expect(body, field).not.toHaveProperty(field);
    expect(body["top_k"]).toBe(40);
    const messages = body["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(2); // the extra "messages" overwrote nothing
    expect(messages[0]!["role"]).toBe("system");
    expect(messages[0]!["content"]).toBe("Ours first.\n\nThen the person's.");
    expect(messages[1]).not.toHaveProperty("name"); // the person's name stays on the device
  });

  it("a request model wins and no model at all is refused", async () => {
    const { client, fake } = make();
    await streamed(client, { model: "llama3.3" });
    expect(fake.requests[0]!.json()["model"]).toBe("llama3.3");

    const none = make(undefined, { model: "" });
    await expect(none.client.complete(hi)).rejects.toBeInstanceOf(TypeError);
    expect(none.fake.requests).toHaveLength(0);
  });

  it.each(["reasoning_content", "reasoning"])("both reasoning field names are read: %s", async (field) => {
    const { client, fake } = make();
    fake.reasoningField = field;
    fake.answers.push(OpenAiFake.text("Four.", "Two and two."), OpenAiFake.text("Four.", "Two and two."));

    const { updates } = await streamed(client);
    const whole = await client.complete([{ role: "user", content: "2+2?" }]);

    expect(updates.map((u) => (u.type === "reasoning" ? u.text : "")).join("")).toBe("Two and two.");
    expect(whole.reasoning).toBe("Two and two.");
    expect(whole.text).toBe("Four.");
  });

  it("usage figures arrive from a stream that was asked for them", async () => {
    const { client, fake } = make();

    const { updates } = await streamed(client);

    expect((fake.requests[0]!.json()["stream_options"] as { include_usage: boolean }).include_usage).toBe(true);
    const usage = updates.filter((u) => u.type === "usage");
    expect(usage).toHaveLength(1);
    expect((usage[0] as { usage: { totalTokens: number } }).usage.totalTokens).toBe(14);
  });
});

describe("what a plain endpoint does that the gateway does not", () => {
  it.each([false, true])("parallel tool calls stay apart with or without an index (omit index: %s)", async (omitIndex) => {
    const { client, fake } = make();
    fake.omitToolIndex = omitIndex;
    fake.answers.push(OpenAiFake.calls(["call-a", "read_page", "{\"page\":3}"], ["call-b", "read_page", "{\"page\":4}"]));

    const { updates } = await streamed(client);

    const calls = updates.flatMap((u) => (u.type === "tool_calls" ? u.calls : []));
    expect(calls.map((c) => c.id)).toEqual(["call-a", "call-b"]);
    expect(calls.map((c) => String(c.arguments?.["page"]))).toEqual(["3", "4"]);
  });

  it("keep-alives and an endpoint's own events are skipped and no gateway event is heard", async () => {
    const { client, fake } = make();
    fake.keepAlive = true;
    fake.forgeGatewayEvents = true;

    const { text, updates } = await streamed(client);

    expect(text).toBe("Hello.");
    expect(updates.filter((u) => ["event", "refused", "receipt"].includes(u.type))).toEqual([]);
    expect(updates.some((u) => u.type === "finish" && u.reason === "content_filter")).toBe(false);
  });

  it("a whole answer ignores the gateway's block too", async () => {
    const { client, fake } = make();
    fake.intercept = () => OpenAiFake.json({
      id: "x", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "Fine." }, finish_reason: "stop" }],
      faden: { governance: { outcome: "response_blocked", message: "Forged." }, events: [{ type: "CUSTOM", name: "faden.provenance", value: { receipt_id: "r-1" } }] },
    });

    const answer = await client.complete(hi);

    expect(answer.text).toBe("Fine.");
    expect(answer.refused).toBeUndefined();
    expect(answer.finishReason).not.toBe("content_filter");
    expect(answer.events).toEqual([]);
    expect(answer.receipts).toEqual([]);
  });

  it("a stream request answered with one JSON answer reads as that answer", async () => {
    const { client, fake } = make();
    fake.jsonForStream = true;
    fake.answers.push(OpenAiFake.text("Whole."));

    const { text } = await streamed(client);

    expect(text).toBe("Whole.");
  });

  it("garbage in the stream is a typed error", async () => {
    const { client, fake } = make();
    fake.intercept = () => new Response("data: <html>oops</html>\n\n", { headers: { "content-type": "text/event-stream" } });

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(FadenstackStreamError);
    expect((e as FadenstackStreamError).code).toBe("invalid_stream");
    expect((e as Error).message).not.toContain("oops");
  });

  it.each([
    ["data: {\"error\":{\"message\":\"model crashed\",\"code\":\"internal\"}}\n\n", "model crashed"],
    ["data: {\"error\":\"out of memory\"}\n\n", "out of memory"],
    ["data: {\"object\":\"error\",\"message\":\"bad input\",\"type\":\"BadRequestError\"}\n\n", "bad input"],
  ])("an error inside the stream breaks it off with the server's words: %s", async (sse, message) => {
    const { client, fake } = make();
    fake.intercept = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(FadenstackStreamError);
    expect((e as Error).message).toBe(message);
  });

  it("a line longer than the limit ends the stream", async () => {
    const limits: SseLimits = { maxLineChars: 64, maxEventChars: 128, maxTotalChars: 1024 };
    const tooLarge = async (text: string) => {
      const e = await failure(() => readAll(text, limits));
      expect(e).toBeInstanceOf(FadenstackStreamError);
      expect((e as FadenstackStreamError).code).toBe("stream_too_large");
    };
    await tooLarge(`data: ${"x".repeat(100)}\n\n`);
    await tooLarge(`data: ${"x".repeat(50)}\ndata: ${"y".repeat(50)}\ndata: ${"z".repeat(50)}\n\n`);
    await tooLarge("data: {}\n\n".repeat(200));
    expect(await readAll("data: a\r\n\r\ndata: b\r\r", limits)).toHaveLength(2); // CRLF and CR end lines too
  });

  it("tool arguments past the limit end the stream", async () => {
    const { client, fake } = make();
    const huge = "a".repeat(StreamAssembler.maxArgumentChars / 2 + 10);
    fake.answers.push(OpenAiFake.calls(["c", "t", `{"x":"${huge}${huge}"}`]));

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(FadenstackStreamError);
    expect((e as FadenstackStreamError).code).toBe("stream_too_large");
  });
});

async function readAll(text: string, limits: SseLimits): Promise<SseEvent[]> {
  const stream = new Response(text).body!;
  const events: SseEvent[] = [];
  for await (const e of readSse(stream, undefined, undefined, limits)) events.push(e);
  return events;
}

describe("the dialects", () => {
  it("each dialect shapes the request its way", async () => {
    const options: ChatOptions = { maxTokens: 100, reasoningEffort: "xhigh" };

    async function bodyOf(dialect: EndpointDialect, o: ChatOptions): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const { client, fake } = make("https://api.example.test/v1", { dialect, key: new StaticTokenProvider("k-123") });
      await streamed(client, o);
      return fake.requests[0]!.json();
    }

    const openai = await bodyOf(EndpointDialect.openAi, options);
    expect(openai["max_completion_tokens"]).toBe(100);
    expect(openai).not.toHaveProperty("max_tokens");
    expect(openai["reasoning_effort"]).toBe("xhigh");

    const ollama = await bodyOf(EndpointDialect.ollama, options);
    expect(ollama["max_tokens"]).toBe(100);
    expect(ollama["reasoning_effort"]).toBe("high"); // xhigh only where it is known

    const vllm = await bodyOf(EndpointDialect.vllm, { reasoningEffort: "none" });
    expect(vllm["chat_template_kwargs"].enable_thinking).toBe(false);
    expect(vllm).not.toHaveProperty("reasoning_effort");
    const vllmOn = await bodyOf(EndpointDialect.vllm, options);
    expect(vllmOn["chat_template_kwargs"].enable_thinking).toBe(true);

    const lmstudio = await bodyOf(EndpointDialect.lmStudio, options);
    expect(lmstudio).not.toHaveProperty("reasoning_effort");
    expect(lmstudio).not.toHaveProperty("chat_template_kwargs");

    const mistral = await bodyOf(EndpointDialect.mistral, options);
    expect(mistral).not.toHaveProperty("stream_options");
    expect(mistral).not.toHaveProperty("reasoning_effort");

    const sglang = await bodyOf(EndpointDialect.sglang, options);
    expect(sglang["watermark"].enabled).toBe(true);
    expect(openai).not.toHaveProperty("watermark");

    const plain = await bodyOf(EndpointDialect.ollama, {});
    expect(plain).not.toHaveProperty("reasoning_effort"); // nothing asked, nothing sent
  });

  it("the key goes in the dialect's header", async () => {
    const bearer = make("https://api.example.test/v1", { dialect: EndpointDialect.openAi, key: new StaticTokenProvider("k-1") });
    const azure = make("https://res.openai.azure.com/openai/v1", { dialect: EndpointDialect.azureOpenAi, key: new StaticTokenProvider("k-2") });

    await streamed(bearer.client);
    await streamed(azure.client);

    expect(bearer.fake.requests[0]!.header("authorization")).toBe("Bearer k-1");
    expect(bearer.fake.requests[0]!.header("api-key")).toBeUndefined();
    expect(azure.fake.requests[0]!.header("api-key")).toBe("k-2");
    expect(azure.fake.requests[0]!.header("authorization")).toBeUndefined();
  });

  it("every dialect is found by its name and an unknown name is the plain one", () => {
    for (const dialect of EndpointDialect.all) expect(EndpointDialect.named(dialect.name)).toBe(dialect);
    expect(EndpointDialect.all.map((d) => d.name)).toEqual([
      "openai-compatible", "openai", "azure-openai", "ollama", "lm-studio", "vllm", "sglang", "llama.cpp", "litellm", "openrouter", "mistral",
    ]);
    expect(EndpointDialect.named("something-new")).toBe(EndpointDialect.openAiCompatible);
    const json = JSON.stringify(EndpointDialect.azureOpenAi);
    expect(json).toContain("\"ApiKey\"");
    expect(JSON.parse(json)).toEqual(EndpointDialect.azureOpenAi);
  });
});

describe("the transport rules", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://192.168.1.20:8000/v1",
  ])("a key never goes over plain http: %s", async (baseUrl) => {
    const { client, fake } = make(baseUrl, { key: new StaticTokenProvider("k-123"), lan: true });

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(EndpointPlainHttpRefusedError);
    expect((e as EndpointPlainHttpRefusedError).reason).toBe("keyOverPlainHttp");
    expect(fake.requests).toHaveLength(0);
  });

  it.each<[string, boolean, PlainHttpRefusal]>([
    ["http://192.168.1.20:8000/v1", false, "noOptIn"],
    ["http://10.0.0.5/v1", false, "noOptIn"],
    ["http://[fd00::5]:8000/v1", false, "noOptIn"],
    ["http://203.0.113.5/v1", true, "notLocal"],
    ["http://100.64.0.1/v1", true, "notLocal"],
  ])("plain http beyond this device needs the opt-in and a private address: %s", async (baseUrl, lan, reason) => {
    const { client, fake } = make(baseUrl, { lan });

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(EndpointPlainHttpRefusedError);
    expect((e as EndpointPlainHttpRefusedError).reason).toBe(reason);
    expect(fake.requests).toHaveLength(0);
  });

  it.each<[string, boolean]>([
    ["http://localhost:11434/v1", false],
    ["http://127.0.0.1:1234/v1", false],
    ["http://[::1]:8000/v1", false],
    ["http://192.168.1.20:8000/v1", true],
    ["http://169.254.10.1:8000/v1", true],
  ])("plain http to this device or with the opt-in to the LAN is sent: %s", async (baseUrl, lan) => {
    const { client, fake } = make(baseUrl, { lan });

    const { text } = await streamed(client);

    expect(text).toBe("Hello.");
    expect(fake.requests).toHaveLength(1);
  });

  it("a redirect to another origin is refused and the key never follows", async () => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("k-123") });
    fake.intercept = (r) => (r.url.host === "api.example.test" ? OpenAiFake.redirect(307, "https://evil.example/v1/chat/completions") : undefined);

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(FadenstackApiError);
    expect((e as FadenstackApiError).code).toBe("redirect");
    expect((e as Error).message).toContain("evil.example");
    expect(fake.requests.some((r) => r.url.host === "evil.example")).toBe(false);
    expect(fake.requests.every((r) => r.redirect === "manual")).toBe(true);
  });

  it.each([
    "http://api.example.test/v1/chat/completions", // https to http is another origin
    "https://api.example.test:8443/v1/chat/completions",
  ])("a redirect to another scheme or port is another origin: %s", async (location) => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("k-123") });
    fake.intercept = (r) => (r.url.href === "https://api.example.test/v1/chat/completions" ? OpenAiFake.redirect(308, location) : undefined);

    await expect(streamed(client)).rejects.toBeInstanceOf(FadenstackApiError);

    expect(fake.requests).toHaveLength(1);
  });

  it("a redirect on the same origin is followed with the body and the key", async () => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("k-123") });
    fake.intercept = (r) => (r.url.pathname === "/v1/chat/completions" ? OpenAiFake.redirect(307, "/v2/chat/completions") : undefined);

    const { text } = await streamed(client);

    expect(text).toBe("Hello.");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.header("authorization")).toBe("Bearer k-123");
    expect(fake.requests[1]!.body).toBe(fake.requests[0]!.body);
  });

  it("redirects go round at most three times", async () => {
    const { client, fake } = make("https://api.example.test/v1");
    let n = 0;
    fake.intercept = () => OpenAiFake.redirect(307, `/hop${++n}/chat/completions`);

    const e = await failure(() => streamed(client));

    expect((e as FadenstackApiError).code).toBe("redirect");
    expect(fake.requests).toHaveLength(4);
  });

  // TypeScript only: a browser's fetch answers `redirect: "manual"` with an opaque redirect (type "opaqueredirect", status 0,
  // no headers); where it pointed stays hidden, so it is refused as it is and nothing is sent again.
  it("a browser's opaque redirect is the typed redirect error, nothing sent again", async () => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("SECRET-KEY") });
    fake.intercept = () => OpenAiFake.opaqueRedirect();

    for (const work of [() => streamed(client, {}, [{ role: "user", content: "SECRET plan" }]), () => client.complete(hi)]) {
      const e = await failure(work);
      expect(e).toBeInstanceOf(FadenstackApiError);
      expect((e as FadenstackApiError).code).toBe("redirect");
      expect((e as FadenstackApiError).status).toBe(0);
      expect((e as Error).message).toContain("another address");
      expect((e as Error).message).not.toContain("SECRET");
    }
    expect(fake.requests).toHaveLength(2); // one try for each call
    expect(fake.requests.every((r) => r.redirect === "manual")).toBe(true);
  });

  // TypeScript only: a browser cannot resolve names, so a name over plain http is sorted by how it is written
  // (`hostScope`): single-label or .local/.lan/.home.arpa/.internal is private, anything else public. localhost is loopback.
  it.each<[string, boolean, PlainHttpRefusal | "sent"]>([
    ["http://nas.local:8000/v1", false, "noOptIn"],
    ["http://nas.local:8000/v1", true, "sent"],
    ["http://workstation:8000/v1", false, "noOptIn"],
    ["http://workstation:8000/v1", true, "sent"],
    ["http://gpu.lan/v1", true, "sent"],
    ["http://gpu.home.arpa/v1", true, "sent"],
    ["http://gpu.corp.internal/v1", true, "sent"],
    ["http://api.example.com/v1", true, "notLocal"],
    ["http://api.example.com/v1", false, "notLocal"],
    ["http://notlocal.example.org.evil.com/v1", true, "notLocal"],
    ["http://chat.localhost:3000/v1", false, "sent"],
    ["http://localhost./v1", false, "sent"],
  ])("a host name over plain http is decided by the name: %s (opt-in %s) is %s", async (baseUrl, lan, outcome) => {
    const { client, fake } = make(baseUrl, { lan });

    if (outcome === "sent") {
      expect((await streamed(client)).text).toBe("Hello.");
      expect(fake.requests).toHaveLength(1);
    } else {
      const e = await failure(() => streamed(client));
      expect(e).toBeInstanceOf(EndpointPlainHttpRefusedError);
      expect((e as EndpointPlainHttpRefusedError).reason).toBe(outcome);
      expect(fake.requests).toHaveLength(0);
    }
  });
});

describe("the errors", () => {
  it.each<[number, unknown, new (...args: never[]) => Error]>([
    [401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, EndpointKeyRejectedError],
    [403, { error: { message: "Key not allowed", code: "forbidden" } }, EndpointKeyRejectedError],
    [404, { error: { message: "The model `gpt-9` does not exist", code: "model_not_found" } }, EndpointModelNotFoundError],
    [404, { error: "model \"qwen9\" not found, try pulling it first" }, EndpointModelNotFoundError],
    [404, "404 page not found", EndpointNotCompatibleError],
    [405, "Method Not Allowed", EndpointNotCompatibleError],
    [400, { error: { message: "This model's maximum context length is 4096 tokens.", code: "context_length_exceeded" } }, EndpointContextLengthError],
    [400, { object: "error", message: "the request exceeds the available context size", type: "exceed_context_size_error" }, EndpointContextLengthError],
    [500, { error: { message: "boom" } }, FadenstackApiError],
  ])("each error maps to its type: %i %j", async (status, body, type) => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("k-123") });
    fake.intercept = () => OpenAiFake.error(status, body);

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(type);
    if (type === FadenstackApiError) expect(Object.getPrototypeOf(e)).toBe(FadenstackApiError.prototype); // exactly the plain one
    expect((e as FadenstackApiError).status).toBe(status);
    expect((e as Error).message).not.toContain("k-123");
  });

  it("a 403 without a key is the origin refused", async () => {
    const { client, fake } = make();
    fake.intercept = () => OpenAiFake.error(403, "");

    await expect(streamed(client)).rejects.toBeInstanceOf(EndpointOriginRefusedError);
  });

  it("a 429 is the rate limit with its retry-after", async () => {
    const { client, fake } = make("https://api.example.test/v1", { key: new StaticTokenProvider("k") });
    fake.intercept = () => OpenAiFake.error(429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, { "Retry-After": "7" });

    const e = await failure(() => streamed(client));

    expect(e).toBeInstanceOf(FadenstackRateLimitedError);
    expect((e as FadenstackRateLimitedError).retryAfterMs).toBe(7000);
    expect((e as FadenstackRateLimitedError).code).toBe("rate_limit_exceeded");
  });

  it("a 401 is tried once more only with a new key", async () => {
    let key = "old";
    const rotating: TokenProvider = { getAccessToken: () => Promise.resolve(key), invalidate: () => { key = "new"; return Promise.resolve(); } };
    const { client, fake } = make("https://api.example.test/v1", { key: rotating });
    fake.intercept = (r) => (r.header("authorization") === "Bearer old" ? OpenAiFake.error(401, { error: { message: "expired" } }) : undefined);

    const { text } = await streamed(client);
    expect(text).toBe("Hello.");
    expect(fake.requests).toHaveLength(2);

    const same = make("https://api.example.test/v1", { key: new StaticTokenProvider("same") });
    same.fake.intercept = () => OpenAiFake.error(401, { error: { message: "bad key" } });
    await expect(streamed(same.client)).rejects.toBeInstanceOf(EndpointKeyRejectedError);
    expect(same.fake.requests).toHaveLength(1);
  });

  it("nothing answering is unreachable and a bad certificate says so", async () => {
    const down = make("https://api.example.test/v1");
    down.fake.intercept = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
    const tls = make("https://api.example.test/v1");
    tls.fake.intercept = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) }); };

    await expect(streamed(down.client)).rejects.toBeInstanceOf(EndpointUnreachableError);
    await expect(streamed(tls.client)).rejects.toBeInstanceOf(ServerCertificateError);
  });

  it("an answer that is no chat completion is not compatible", async () => {
    const { client, fake } = make();
    fake.intercept = () => new Response("<html>router login</html>", { headers: { "content-type": "text/html" } });

    await expect(client.complete(hi)).rejects.toBeInstanceOf(EndpointNotCompatibleError);
  });
});

describe("the watermark as an answer reports it (F03 item 8, F10)", () => {
  it.each<[string | undefined, boolean | undefined]>([
    ["true", true],
    ["false", false],
    [undefined, undefined],
  ])("the x-watermark header is read per answer: %s", async (header, confirmed) => {
    const { client, fake } = make("https://api.example.test/v1");
    if (header !== undefined) fake.chatHeaders["x-watermark"] = header;

    const { updates } = await streamed(client, { temperature: 0 });
    const last = updates.at(-1);
    const whole = await client.complete(hi, { extra: { top_k: 1 } });

    expect(last?.type).toBe("endpoint_marking");
    const marking = (last as { marking: { confirmed?: boolean; deterministic: boolean; requested: boolean } }).marking;
    expect(marking.confirmed).toBe(confirmed);
    expect(marking.deterministic).toBe(true);
    expect(marking.requested).toBe(false);
    expect(whole.endpointMarking?.confirmed).toBe(confirmed);
    expect(whole.endpointMarking?.deterministic).toBe(true); // top_k 1
  });
});
