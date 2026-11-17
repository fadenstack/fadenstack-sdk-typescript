import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EndpointCheck,
  EndpointDialect,
  EndpointPlace,
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

  it("the tool probe leaves a thinking model room: 1024 tokens", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    await check.run();
    const probe = fake.requests.find((r) => r.body.includes("report_ready"))!;
    expect(probe.json()["max_tokens"]).toBe(1024);
  });

  it("a probe that reasons and ends on the length limit without a call is not known, not chat only (F9)", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.ended("length", undefined, "I should call the tool, but first let me think about it for a long time"));

    const report = await check.run();

    expect(report.toolCalls).toBeNull();
    expect(report.chatOnly).toBe(false);
    expect(report.problems).not.toContain(EndpointProblem.NoToolCalls);
    expect(report.usable).toBe(true);
  });

  it("a probe that ends with no finish reason and no call is not known", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.ended("", "..."));
    const report = await check.run();
    expect(report.toolCalls).toBeNull();
    expect(report.problems).not.toContain(EndpointProblem.NoToolCalls);
  });

  it("a finished answer without a call is false, and a call after reasoning is true", async () => {
    const said = make();
    said.fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.text("I am ready.", "thinking"));
    const no = await said.check.run();
    expect(no.toolCalls).toBe(false);
    expect(no.problems).toContain(EndpointProblem.NoToolCalls);

    const called = make();
    called.fake.answers.push(OpenAiFake.text("OK"), { ...OpenAiFake.calls(["call-1", "report_ready", "{}"]), reasoning: "thinking" });
    expect((await called.check.run()).toolCalls).toBe(true);
  });

  it("a model the server says has no tools is chat only", async () => {
    const { check, fake } = make();
    fake.intercept = (r) => (r.body.includes("report_ready")
      ? OpenAiFake.error(400, { error: { message: "registry.ollama.ai/library/gemma:2b does not support tools" } }) : undefined);

    const report = await check.run();

    expect(report.chatOnly).toBe(true);
  });

  it.each([
    ["http://127.0.0.1:1234/v1", true, true],
    ["http://localhost:11434/v1", true, true],
    ["https://api.example.test/v1", true, false],
    ["http://localhost:11434/v1", false, false],
  ])("says a key travels unencrypted on this computer only for a keyed http endpoint: %s (key %s)", async (baseUrl, keyed, said) => {
    const { check, fake } = make(baseUrl, EndpointDialect.openAiCompatible, keyed ? new StaticTokenProvider("k-1") : undefined);
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));

    const report = await check.run();

    expect(report.problems.includes(EndpointProblem.KeyUnencryptedOnThisComputer)).toBe(said);
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
    asked.fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]), OpenAiFake.text("Green."));
    const withPicture = await asked.check.run({ probeVision: true });
    expect(withPicture.vision).toBe(true);
    expect(asked.fake.requests.some((r) => r.body.includes("image_url"))).toBe(true);
  });

  /** The probe against a model that answers the picture with `answer`. */
  async function seeing(answer: string, reasoning?: string) {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]), OpenAiFake.text(answer, reasoning));
    const report = await check.run({ probeVision: true });
    return { report, fake };
  }

  it.each([["Green.", true], ["green", true], ["It is GREEN", true], ["Blue", false], ["I cannot see images.", false], ["", false], ["greenish", false]])(
    "the vision probe: the answer %j gives vision %s", async (answer, expected) => {
      expect((await seeing(answer)).report.vision).toBe(expected);
    });

  it("the vision probe reads the answer, not the reasoning", async () => {
    expect((await seeing("", "The picture is green, I think.")).report.vision).toBe(false);
    expect((await seeing("Green", "Hmm, blue?")).report.vision).toBe(true);
  });

  it("the vision probe sends a 64x64 green PNG as an image part and leaves room for a reasoning model", async () => {
    const { fake } = await seeing("Green");
    const picture = fake.requests.filter(isChat).find((r) => r.body.includes("image_url"))!.json();
    expect(picture["max_tokens"]).toBe(256);
    const parts = (picture["messages"] as { content: { type: string; text?: string; image_url?: { url: string } }[] }[])[0]!.content;
    expect(parts.find((p) => p.type === "text")!.text).toBe("What colour is this picture? One word.");
    const url = parts.find((p) => p.type === "image_url")!.image_url!.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    expect(bytes.readUInt32BE(16)).toBe(64); // width
    expect(bytes.readUInt32BE(20)).toBe(64); // height
    // The same literal as in the .NET tests: the two SDKs send the same picture.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("931d03be1da351bf941b2244ee433b9e69215f8294432340c1c64ab818d2a119");
  });

  it("the vision probe is false on an API error", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    fake.intercept = (r) => (isChat(r) && r.body.includes("image_url") ? OpenAiFake.error(400, "images are not supported") : undefined);
    expect((await check.run({ probeVision: true })).vision).toBe(false);
  });

  describe("Ollama's context length", () => {
    const loaded = (name: string, length: number) => ({ models: [{ name, model: name, context_length: length }] });

    it("num_ctx of the model wins over /api/ps", async () => {
      const { check, fake } = make();
      fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "num_ctx 16384" };
      fake.ollamaPs = loaded("qwen3:14b", 4096);
      const report = await check.run();
      expect(report.contextLength).toBe(16384);
      expect(report.problems).not.toContain(EndpointProblem.OllamaDefaultContext);
    });

    it("without num_ctx, the loaded model's length in /api/ps is the running one (after the chat probe)", async () => {
      const { check, fake } = make();
      fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "temperature 0.6" };
      fake.ollamaPs = { models: [{ name: "other:1b", context_length: 2048 }, { name: "x", model: "qwen3:14b", context_length: 8192 }] };
      const report = await check.run();
      expect(report.contextLength).toBe(8192);
      expect(report.modelContextLength).toBe(40960);
      expect(report.problems).not.toContain(EndpointProblem.OllamaDefaultContext);
      const order = fake.requests.map((r) => (isChat(r) ? "chat" : r.url.pathname.split("/").slice(-2).join("/")));
      expect(order.indexOf("api/ps")).toBeGreaterThan(order.lastIndexOf("chat"));
    });

    it("the person's setting wins over /api/ps", async () => {
      const { check, fake } = make();
      fake.ollamaShow = { parameters: "temperature 0.6" };
      fake.ollamaPs = loaded("qwen3:14b", 8192);
      expect((await check.run({ contextLength: 32000 })).contextLength).toBe(32000);
    });

    it("/api/ps without the model leaves the length unknown and the problem", async () => {
      const { check, fake } = make();
      fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "temperature 0.6" };
      fake.ollamaPs = loaded("other:1b", 8192);
      const report = await check.run();
      expect(report.contextLength).toBeNull();
      expect(report.problems).toContain(EndpointProblem.OllamaDefaultContext);
    });

    it("a failing /api/ps leaves the length unknown and the problem", async () => {
      const { check, fake } = make();
      fake.ollamaShow = { model_info: { "qwen3.context_length": 40960 }, parameters: "temperature 0.6" };
      const report = await check.run(); // the fake answers 404
      expect(report.contextLength).toBeNull();
      expect(report.modelContextLength).toBe(40960);
      expect(report.problems).toContain(EndpointProblem.OllamaDefaultContext);
    });
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
      "toolCalls", "vision", "thinksWhenOff", "contextLength", "modelContextLength", "pictures", "watermark", "problems",
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
    expect(report.thinksWhenOff).toBeNull(); // a report saved without the field
  });

  it("thinksWhenOff round trips and a report without it reads as null (F10)", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), { ...OpenAiFake.calls(["call-1", "report_ready", "{}"]), reasoning: "hmm" });
    const report = await check.run();
    expect(report.thinksWhenOff).toBe(true);
    expect(JSON.parse(report.toJson())["thinksWhenOff"]).toBe(true);
    expect(EndpointReport.fromJson(report.toJson()).thinksWhenOff).toBe(true);
    const without = JSON.parse(report.toJson()) as Record<string, unknown>;
    delete without["thinksWhenOff"];
    expect(EndpointReport.fromJson(JSON.stringify(without)).thinksWhenOff).toBeNull();
  });
});

describe("thinking under the off switch (F10)", () => {
  const toolProbe = (r: { body: string }) => r.body.includes("report_ready");

  it("a probe stream that reasons under \"none\" gives thinksWhenOff true, and the probe sent \"none\"", async () => {
    const { check, fake } = make();
    fake.reasoningField = "reasoning";
    fake.answers.push(OpenAiFake.text("OK"), { ...OpenAiFake.calls(["call-1", "report_ready", "{}"]), reasoning: "The user wants a call." });
    const report = await check.run();
    expect(report.thinksWhenOff).toBe(true);
    expect(fake.requests.find(toolProbe)!.json()["reasoning_effort"]).toBe("none");
  });

  it("a probe with no reasoning gives false", async () => {
    const { check, fake } = make();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    expect((await check.run()).thinksWhenOff).toBe(false);
  });

  it("a dialect with no switch gives null, even when reasoning came", async () => {
    const { check, fake } = make("http://localhost:1234/v1", EndpointDialect.lmStudio);
    fake.answers.push(OpenAiFake.text("OK"), { ...OpenAiFake.calls(["call-1", "report_ready", "{}"]), reasoning: "hmm" });
    const report = await check.run();
    expect(report.thinksWhenOff).toBeNull();
    expect(fake.requests.find(toolProbe)!.json()["reasoning_effort"]).toBeUndefined();
  });

  it("a chat-template dialect sends its off switch and notes the reasoning too", async () => {
    const { check, fake } = make("http://localhost:8000/v1", EndpointDialect.vllm);
    fake.answers.push(OpenAiFake.text("OK"), { ...OpenAiFake.calls(["call-1", "report_ready", "{}"]), reasoning: "hmm" });
    const report = await check.run();
    expect(report.thinksWhenOff).toBe(true);
    expect(fake.requests.find(toolProbe)!.json()["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("the probe keeps the real off switch when the dialect already knows the model thinks", async () => {
    const fake = new OpenAiFake();
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]));
    const check = new EndpointCheck({ baseUrl: "http://localhost:11434/v1", model: "m", dialect: { ...EndpointDialect.ollama, thinksWhenOff: true }, fetch: fake.fetch });
    await check.run();
    expect(fake.requests.find(toolProbe)!.json()["reasoning_effort"]).toBe("none");
  });
});

describe("pictures: what /models says, else the probe (F2)", () => {
  const withListing = (fields: Record<string, unknown>, answers: Parameters<OpenAiFake["answers"]["push"]>) => {
    const fake = new OpenAiFake();
    fake.models = ["vision-model"];
    fake.modelFields["vision-model"] = fields;
    fake.answers.push(...answers);
    const check = new EndpointCheck({ baseUrl: "https://openrouter.ai/api/v1", model: "vision-model", dialect: EndpointDialect.openRouter, fetch: fake.fetch });
    return { check, fake };
  };
  const calls = [OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"])];

  it("input_modalities with an image gives vision true and no picture is sent", async () => {
    const { check, fake } = withListing({ architecture: { input_modalities: ["text", "image"] } }, calls);
    const report = await check.run({ probeVision: true });
    expect(report.vision).toBe(true);
    expect(fake.requests.some((r) => r.body.includes("image_url"))).toBe(false);
  });

  it("input_modalities with text only gives vision false and no picture is sent", async () => {
    const { check, fake } = withListing({ architecture: { input_modalities: ["text"] } }, calls);
    const report = await check.run({ probeVision: true });
    expect(report.vision).toBe(false);
    expect(fake.requests.some((r) => r.body.includes("image_url"))).toBe(false);
  });

  it("the listing decides even when the check was not asked to probe", async () => {
    const { check } = withListing({ architecture: { input_modalities: ["image", "text"] } }, calls);
    expect((await check.run()).vision).toBe(true);
  });

  it("a listing that does not say leaves it to the probe", async () => {
    const { check, fake } = withListing({ architecture: {} }, [...calls, OpenAiFake.text("Green")]);
    expect((await check.run({ probeVision: true })).vision).toBe(true);
    expect(fake.requests.some((r) => r.body.includes("image_url"))).toBe(true);
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

describe("no model named yet, and where an address points", () => {
  it("sends nothing to a model before the pick: with no model named only /models is asked (F3)", async () => {
    const fake = new OpenAiFake();
    fake.models = ["llama3:8b", "qwen3:14b"];
    const check = new EndpointCheck({ baseUrl: "http://localhost:11434/v1", model: "", dialect: EndpointDialect.ollama, fetch: fake.fetch });

    const report = await check.run({ probeVision: true });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url.pathname).toBe("/v1/models");
    expect(fake.requests.some(isChat)).toBe(false);
    expect(report.reachable).toBe(true);
    expect(report.keyAccepted).toBe(true);
    expect(report.models).toEqual(["llama3:8b", "qwen3:14b"]);
    expect(report.server).toBe(EndpointServer.Ollama);
    expect(report.model).toBe("");
    expect(report.chat).toBeNull();
    expect(report.usage).toBeNull();
    expect(report.toolCalls).toBeNull();
    expect(report.vision).toBeNull();
    expect(report.usable).toBe(false);
  });

  it("before the pick a vLLM server's version is still read (it sends nothing to a model), and after the pick the probes go to the picked model only", async () => {
    const fake = new OpenAiFake();
    fake.models = ["a", "b"];
    fake.vllmVersion = "0.31.0";
    const open = new EndpointCheck({ baseUrl: "http://localhost:8000/v1", dialect: EndpointDialect.vllm, fetch: fake.fetch });
    const before = await open.run();
    expect(before.serverVersion).toBe("0.31.0");
    expect(fake.requests.map((r) => r.url.pathname)).toEqual(["/v1/models", "/version"]);

    const picked = new EndpointCheck({ baseUrl: "http://localhost:8000/v1", model: "b", dialect: EndpointDialect.vllm, fetch: fake.fetch });
    fake.answers.push(OpenAiFake.text("OK"), OpenAiFake.calls(["call-1", "report_ready", "{}"]), OpenAiFake.text("Green"));
    const after = await picked.run({ probeVision: true });
    expect(after.model).toBe("b");
    expect(after.chat).toBe(true);
    const chats = fake.requests.filter(isChat);
    expect(chats).toHaveLength(3);
    expect(chats.every((r) => r.json()["model"] === "b")).toBe(true);
  });

  it("keeps a model the endpoint names", async () => {
    const { check, fake } = make("http://localhost:11434/v1", EndpointDialect.ollama, undefined, "qwen3:14b");
    fake.models = ["llama3:8b", "qwen3:14b"];

    const report = await check.run();

    expect(report.model).toBe("qwen3:14b");
    expect(fake.requests.filter(isChat).every((r) => r.json()["model"] === "qwen3:14b")).toBe(true);
  });

  it.each<[string, EndpointPlace]>([
    ["http://127.0.0.1:11434/v1", EndpointPlace.ThisComputer],
    ["http://[::1]:1234", EndpointPlace.ThisComputer],
    ["http://localhost:8000", EndpointPlace.ThisComputer],
    ["http://192.168.1.20", EndpointPlace.LocalNetwork],
    ["http://10.0.0.5", EndpointPlace.LocalNetwork],
    ["http://nas.local", EndpointPlace.LocalNetwork],
    ["http://8.8.8.8", EndpointPlace.Internet],
    ["http://100.64.0.1", EndpointPlace.Internet],
    ["http://example.com", EndpointPlace.Internet],
  ])("placeOf %s", (url, place) => {
    expect(EndpointCheck.placeOf(url)).toBe(place);
    expect(EndpointCheck.placeOf(new URL(url))).toBe(place);
  });
});