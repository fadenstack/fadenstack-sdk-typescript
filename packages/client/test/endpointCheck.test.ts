import { describe, expect, it } from "vitest";

import {
  EndpointCheck,
  EndpointDialect,
  EndpointPreset,
  EndpointProblem,
  EndpointReport,
  EndpointServer,
  StaticTokenProvider,
  TextWatermark,
  TextWatermarks,
  type EndpointCheckOptions,
  type TokenProvider,
} from "@fadenstack/client";
import { OpenAiFake } from "@fadenstack/testing";

// sdk/51 F03, I03 commit 7: the endpoint check, the presets and the watermark status. One test for each of the .NET
// EndpointCheckTests, minus the local search (a browser may not scan ports: the check covers only the configured origin).

function make(baseUrl = "http://localhost:11434/v1", dialect: EndpointDialect = EndpointDialect.ollama, key?: TokenProvider, model = "qwen3:14b"):
  { check: EndpointCheck; fake: OpenAiFake } {
  const fake = new OpenAiFake();
  const check = new EndpointCheck({ baseUrl, model, dialect, fetch: fake.fetch, ...(key ? { key } : {}) });
  return { check, fake };
}

const isChat = (r: { url: URL }) => r.url.pathname.endsWith("/chat/completions");

describe("the endpoint check", () => {
  it("never asks anything but the configured origin (there is no local search in a browser)", async () => {
    const { check, fake } = make("http://localhost:11434/v1");
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "num_ctx 16384" };

    await check.run({ probeVision: true });

    expect(fake.requests.length).toBeGreaterThan(3);
    expect(new Set(fake.requests.map((r) => r.url.origin))).toEqual(new Set(["http://localhost:11434"]));
  });

  it("each step runs against the endpoint and nothing else", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "num_ctx 16384\ntemperature 0.6" };

    const report = await check.run({ requiredContextTokens: 8000 });

    expect(report.reachable).toBe(true);
    expect(report.keyAccepted).toBe(true);
    expect(report.models).toEqual(["qwen3:14b"]);
    expect(report.chat).toBe(true);
    expect(report.usage).toBe(true);
    expect(report.toolCalls).toBe(true);
    expect(report.chatOnly).toBe(false);
    expect(report.contextLength).toBe(16384);
    expect(report.modelContextLength).toBe(40960);
    expect(report.pictures).toBe(false);
    expect(report.problems).toEqual([]);
    expect(report.usable).toBe(true);
    expect(fake.requests.every((r) => r.url.host === "localhost:11434")).toBe(true);
    const probe = fake.requests.filter((r) => r.body.includes("report_ready"));
    expect(probe).toHaveLength(1);
    expect(probe[0]!.json()["tool_choice"]).toBe("required");
    expect(fake.requests.find(isChat)!.json()["max_tokens"]).toBe(1);
  });

  it("an ollama endpoint does not mark text and its default context is said", async () => {
    const { check, fake } = make();
    fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "temperature 0.6" };

    const report = await check.run();

    expect(report.server).toBe(EndpointServer.Ollama);
    expect(report.watermark.status).toBe(TextWatermark.Never);
    expect(report.watermark.source).not.toBeNull();
    expect(report.watermark.checked).toBe("2026-11-14");
    expect(report.problems).toContain(EndpointProblem.OllamaDefaultContext);
    expect(report.contextLength).toBeNull();
  });

  it("a model that cannot call tools is chat only", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.text("I am ready."));

    const report = await check.run();

    expect(report.toolCalls).toBe(false);
    expect(report.chatOnly).toBe(true);
    expect(report.problems).toContain(EndpointProblem.NoToolCalls);
    expect(report.usable).toBe(true); // it can still talk
  });

  it("a model the server says has no tools is chat only", async () => {
    const { check, fake } = make();
    fake.intercept = (r) => (r.body.includes("report_ready")
      ? OpenAiFake.error(400, { error: { message: "registry.ollama.ai/library/gemma:2b does not support tools" } }) : undefined);

    const report = await check.run();

    expect(report.chatOnly).toBe(true);
  });

  it("a bad key stops the check there", async () => {
    const { check, fake } = make("https://api.example.test/v1", EndpointDialect.openAi, new StaticTokenProvider("k-bad"));
    fake.intercept = () => OpenAiFake.error(401, { error: { message: "Incorrect API key" } });

    const report = await check.run();

    expect(report.reachable).toBe(true);
    expect(report.keyAccepted).toBe(false);
    expect(report.problems).toEqual([EndpointProblem.KeyRejected]);
    expect(report.usable).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it("nothing listening is unreachable", async () => {
    const { check, fake } = make();
    fake.intercept = () => { throw new TypeError("fetch failed"); };

    const report = await check.run();

    expect(report.reachable).toBe(false);
    expect(report.problems).toEqual([EndpointProblem.Unreachable]);
  });

  it("a model the server does not list is named", async () => {
    const { check } = make(undefined, undefined, undefined, "qwen9:1t");

    const report = await check.run();

    expect(report.problems).toContain(EndpointProblem.ModelNotFound);
  });

  it("a stream without usage figures is said and a short context warned", async () => {
    const { check, fake } = make(undefined, EndpointDialect.openAiCompatible);
    fake.streamUsage = false;

    const report = await check.run({ contextLength: 4096, requiredContextTokens: 12000 } satisfies EndpointCheckOptions);

    expect(report.usage).toBe(false);
    expect(report.contextLength).toBe(4096);
    expect(report.problems).toContain(EndpointProblem.NoUsage);
    expect(report.problems).toContain(EndpointProblem.ContextTooShort);
  });

  it.each<[string | undefined, string]>([
    ["0.29.1", TextWatermark.Never],
    ["0.30.0", TextWatermark.IfOperatorConfigured],
    ["0.33.0", TextWatermark.IfOperatorConfigured],
    [undefined, TextWatermark.IfOperatorConfigured],
  ])("a vllm server marks only from 0.30 and only if configured: %s", async (version, status) => {
    const { check, fake } = make("http://localhost:8000/v1", EndpointDialect.openAiCompatible);
    fake.vllmVersion = version;
    fake.intercept = (r) => (r.url.pathname === "/v1/models"
      ? OpenAiFake.json({ object: "list", data: [{ id: "qwen3:14b", owned_by: "vllm", max_model_len: 32768 }] }) : undefined);

    const report = await check.run();

    expect(report.server).toBe(EndpointServer.Vllm);
    expect(report.serverVersion).toBe(version ?? null);
    expect(report.watermark.status).toBe(status);
    expect(report.contextLength).toBe(32768);
  });

  it("an sglang server is asked for the mark and a refusal is said", async () => {
    const { check, fake } = make("http://localhost:30000/v1", EndpointDialect.sglang);
    fake.intercept = (r) => (r.body.includes("\"watermark\"")
      ? OpenAiFake.error(400, { object: "error", message: "Watermarking is not enabled on this server.", type: "BadRequestError" }) : undefined);

    const report = await check.run();

    expect(report.chat).toBe(true);
    expect(report.problems).toContain(EndpointProblem.WatermarkRequestRefused);
    expect(report.watermark.requested).toBe(false);
    expect(fake.requests.some((r) => r.body.includes("\"watermark\""))).toBe(true);
    expect(fake.requests.some((r) => isChat(r) && !r.body.includes("\"watermark\""))).toBe(true);
  });

  it("an sglang server that takes the request keeps it", async () => {
    const { check } = make("http://localhost:30000/v1", EndpointDialect.sglang);

    const report = await check.run();

    expect(report.watermark.requested).toBe(true);
    expect(report.watermark.status).toBe(TextWatermark.IfOperatorConfigured);
  });

  it.each<[string, string]>([
    ["https://api.anthropic.com/v1", TextWatermark.Marks],
    ["https://api.openai.com/v1", TextWatermark.IfAccountEnabled],
    ["https://api.x.ai/v1", TextWatermark.IfAccountEnabled],
    ["https://res.openai.azure.com/openai/v1", TextWatermark.Unknown],
    ["https://api.mistral.ai/v1", TextWatermark.Unknown],
    ["https://openrouter.ai/api/v1", TextWatermark.Unknown],
  ])("the cloud is known by its host: %s", async (baseUrl, status) => {
    const { check } = make(baseUrl, EndpointDialect.openAiCompatible, new StaticTokenProvider("k"));

    const report = await check.run();

    expect(report.watermark.status).toBe(status);
  });

  it("the x-watermark header is read", async () => {
    const { check, fake } = make("https://api.x.ai/v1", EndpointDialect.openAiCompatible, new StaticTokenProvider("k"));
    fake.chatHeaders["x-watermark"] = "true";

    const report = await check.run();

    expect(report.watermark.confirmed).toBe(true);
  });

  it("the vision probe runs only when asked", async () => {
    const { check, fake } = make();
    const without = await check.run();
    expect(without.vision).toBeNull();
    expect(fake.requests.some((r) => r.body.includes("image_url"))).toBe(false);

    const asked = make();
    const withPicture = await asked.check.run({ probeVision: true });
    expect(withPicture.vision).toBe(true);
    expect(asked.fake.requests.some((r) => r.body.includes("image_url"))).toBe(true);
  });

  it("the report round trips as json", async () => {
    const { check, fake } = make();
    fake.ollamaShow = { parameters: "num_ctx 8192" };
    const report = await check.run();

    const back = EndpointReport.fromJson(report.toJson());

    expect(back.toJson()).toBe(report.toJson());
    expect(report.toJson()).toContain("\"watermark\":{\"status\":\"Never\"");
    expect(back.contextLength).toBe(8192);
    // .NET's keys, in .NET's order, and its enum strings.
    const json = JSON.parse(report.toJson()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "baseUrl", "model", "checkedAt", "server", "serverVersion", "dialect", "reachable", "keyAccepted", "models", "chat", "usage",
      "toolCalls", "vision", "contextLength", "modelContextLength", "pictures", "watermark", "problems",
    ]);
    expect(json["server"]).toBe("Ollama");
    expect(json["dialect"]).toBe("ollama");
    expect(json["vision"]).toBeNull();
    expect(Object.keys(json["watermark"] as object)).toEqual(["status", "source", "checked", "requested", "confirmed"]);
  });

  it("a .NET report reads back", () => {
    const dotnet = "{\"baseUrl\":\"http://localhost:11434/v1\",\"model\":\"m\",\"checkedAt\":\"2026-11-14T10:20:30.1234567+00:00\",\"server\":\"Ollama\","
      + "\"serverVersion\":null,\"dialect\":\"ollama\",\"reachable\":true,\"keyAccepted\":true,\"models\":[\"m\"],\"chat\":true,\"usage\":true,"
      + "\"toolCalls\":false,\"vision\":null,\"contextLength\":null,\"modelContextLength\":40960,\"pictures\":false,"
      + "\"watermark\":{\"status\":\"Never\",\"source\":\"https://github.com/ollama/ollama\",\"checked\":\"2026-11-14\",\"requested\":false,\"confirmed\":null},"
      + "\"problems\":[\"NoToolCalls\",\"OllamaDefaultContext\"]}";

    const report = EndpointReport.fromJson(dotnet);

    expect(report.server).toBe(EndpointServer.Ollama);
    expect(report.chatOnly).toBe(true);
    expect(report.problems).toEqual([EndpointProblem.NoToolCalls, EndpointProblem.OllamaDefaultContext]);
    expect(report.checkedAt).toBe(Date.parse("2026-11-14T10:20:30.123Z"));
  });
});

describe("the presets and the versions", () => {
  it("every preset has its dialect and the local ones their loopback base", () => {
    expect(EndpointPreset.all.map((p) => p.id)).toEqual(
      ["openai", "azure-openai", "ollama", "lm-studio", "vllm", "sglang", "llama.cpp", "litellm", "openrouter", "mistral"]);
    for (const p of EndpointPreset.all) expect(p.dialect.name).toBe(p.id);
    for (const p of EndpointPreset.all.filter((x) => x.local)) expect(new URL(p.baseUrl!).hostname).toBe("localhost");
    for (const p of EndpointPreset.all.filter((x) => x.baseUrl?.startsWith("https:"))) expect(p.needsKey).toBe(true);
    expect(EndpointPreset.named("MISTRAL")).toBe(EndpointPreset.mistral);
    expect(EndpointPreset.named("nope")).toBeUndefined();
  });

  it.each<[string, [number, number, number] | undefined]>([
    ["0.30.0", [0, 30, 0]],
    ["v0.5.22", [0, 5, 22]],
    ["0.33.0rc1+cu130", [0, 33, 0]],
    ["nightly", undefined],
  ])("versions read as numbers: %s", (text, expected) => {
    expect(TextWatermarks.parse(text)).toEqual(expected);
  });
});
