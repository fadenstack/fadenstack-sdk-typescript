import type { ChatMessage, ChatOptions } from "../chat/types.js";
import { FadenstackApiError, FadenstackError, FadenstackRateLimitedError } from "../errors.js";
import { DirectChatClient } from "./directChatClient.js";
import { EndpointDialect, EndpointServer, type ModelEndpoint } from "./endpoint.js";
import {
  EndpointKeyRejectedError,
  EndpointModelNotFoundError,
  EndpointNotCompatibleError,
  EndpointOriginRefusedError,
  EndpointPlainHttpRefusedError,
  EndpointUnreachableError,
  ServerCertificateError,
} from "./endpointErrors.js";
import { EndpointTransport, toEndpointError } from "./endpointTransport.js";
import { endpointModels, endpointRoot } from "./endpointUrl.js";
import { TextWatermarks, type EndpointWatermarkStatus } from "./textWatermarks.js";

/** What the check found wrong or worth saying, for the wizard (F15) to say in plain words. The strings are .NET's `EndpointProblem` names. */
export const EndpointProblem = Object.freeze({
  Unreachable: "Unreachable",
  CertificateNotTrusted: "CertificateNotTrusted",
  PlainHttpRefused: "PlainHttpRefused",
  KeyRejected: "KeyRejected",
  OriginRefused: "OriginRefused",
  NotCompatible: "NotCompatible",
  RateLimited: "RateLimited",
  ModelNotFound: "ModelNotFound",
  /** The model answered, but no tool call came back: the agent can only talk ("chat only"). */
  NoToolCalls: "NoToolCalls",
  /** A stream brought no usage figures: the token counts stay unknown. */
  NoUsage: "NoUsage",
  /** The context is shorter than the instructions, tools and history need. */
  ContextTooShort: "ContextTooShort",
  /** Ollama runs the model with its default context length, which cuts long prompts without a word. */
  OllamaDefaultContext: "OllamaDefaultContext",
  /** The server refused the request for its watermark; requests go without it. */
  WatermarkRequestRefused: "WatermarkRequestRefused",
  Failed: "Failed",
} as const);
export type EndpointProblem = (typeof EndpointProblem)[keyof typeof EndpointProblem];

/** What the check is to do. */
export interface EndpointCheckOptions {
  /** Also send a small picture and see whether the model takes it (optional; the person may set it instead). */
  probeVision?: boolean;
  /** The context length the person set, which wins over what the server says. */
  contextLength?: number;
  /** About how many tokens the instructions, the tools and the history need: below it the check warns. */
  requiredContextTokens?: number;
  /** Cancels the check. */
  signal?: AbortSignal;
}

/** The fields of a report; absent values are `null`, as .NET writes them. */
export interface EndpointReportData {
  baseUrl: string;
  model: string;
  /** When the check ran (ms since the epoch). */
  checkedAt: number;
  server: EndpointServer;
  serverVersion: string | null;
  /** The dialect the check found fits (a preset's, or the server's own when the check recognised it). */
  dialect: string;
  reachable: boolean;
  /** Whether the key (or no key) was accepted; null when the check did not get that far. */
  keyAccepted: boolean | null;
  /** The models `/models` lists; empty when it lists none or has no such route. */
  models: string[];
  /** Whether the chosen model answered a one-token streamed chat. */
  chat: boolean | null;
  /** Whether a stream brought usage figures. */
  usage: boolean | null;
  /** Whether the model calls tools; false means the agent can only talk. */
  toolCalls: boolean | null;
  /** Whether the model took a picture; null when not probed. */
  vision: boolean | null;
  /** The context length that applies: the person's, else the server's running setting, else null (unknown). */
  contextLength: number | null;
  /** The model's own maximum, where the server says (Ollama's model_info, vLLM's max_model_len). */
  modelContextLength: number | null;
  /** Pictures: off in standalone until D17 (owner, 14 Nov), so always false here. */
  pictures: boolean;
  watermark: EndpointWatermarkStatus;
  problems: EndpointProblem[];
}

const SERVERS: ReadonlySet<string> = new Set(Object.values(EndpointServer));
const PROBLEMS: ReadonlySet<string> = new Set(Object.values(EndpointProblem));
const WATERMARKS: ReadonlySet<string> = new Set(["Unknown", "Marks", "IfAccountEnabled", "IfOperatorConfigured", "Never"]);

/**
 * The check's result (sdk/51 F03): serialisable, so the app keeps it with the connection and the records cite it (F10).
 * `toJson()` writes the same keys (camelCase) and enum strings as .NET's `EndpointReport.ToJson()`; `checkedAt` is an ISO
 * date-time in UTC (`...Z`) where .NET writes its own offset form, and `fromJson` reads both. .NET: `EndpointReport`.
 */
export class EndpointReport implements EndpointReportData {
  readonly baseUrl: string;
  readonly model: string;
  readonly checkedAt: number;
  readonly server: EndpointServer;
  readonly serverVersion: string | null;
  readonly dialect: string;
  readonly reachable: boolean;
  readonly keyAccepted: boolean | null;
  readonly models: string[];
  readonly chat: boolean | null;
  readonly usage: boolean | null;
  readonly toolCalls: boolean | null;
  readonly vision: boolean | null;
  readonly contextLength: number | null;
  readonly modelContextLength: number | null;
  readonly pictures: boolean;
  readonly watermark: EndpointWatermarkStatus;
  readonly problems: EndpointProblem[];

  constructor(data: EndpointReportData) {
    this.baseUrl = data.baseUrl;
    this.model = data.model;
    this.checkedAt = data.checkedAt;
    this.server = data.server;
    this.serverVersion = data.serverVersion;
    this.dialect = data.dialect;
    this.reachable = data.reachable;
    this.keyAccepted = data.keyAccepted;
    this.models = [...data.models];
    this.chat = data.chat;
    this.usage = data.usage;
    this.toolCalls = data.toolCalls;
    this.vision = data.vision;
    this.contextLength = data.contextLength;
    this.modelContextLength = data.modelContextLength;
    this.pictures = data.pictures;
    this.watermark = { ...data.watermark };
    this.problems = [...data.problems];
  }

  /** The agent can only talk: the model calls no tools. */
  get chatOnly(): boolean {
    return this.toolCalls === false;
  }

  /** Everything the agent needs worked: reachable, the key, a chat. */
  get usable(): boolean {
    return this.reachable && this.keyAccepted !== false && this.chat === true;
  }

  /** The report as JSON, with .NET's keys in .NET's order. */
  toJson(): string {
    const w = this.watermark;
    return JSON.stringify({
      baseUrl: this.baseUrl, model: this.model, checkedAt: new Date(this.checkedAt).toISOString(), server: this.server,
      serverVersion: this.serverVersion, dialect: this.dialect, reachable: this.reachable, keyAccepted: this.keyAccepted,
      models: this.models, chat: this.chat, usage: this.usage, toolCalls: this.toolCalls, vision: this.vision,
      contextLength: this.contextLength, modelContextLength: this.modelContextLength, pictures: this.pictures,
      watermark: { status: w.status, source: w.source, checked: w.checked, requested: w.requested, confirmed: w.confirmed },
      problems: this.problems,
    });
  }

  /** A report from `toJson()`'s text (or .NET's); throws a `TypeError` when it is not one. */
  static fromJson(json: string): EndpointReport {
    const root: unknown = JSON.parse(json);
    if (root === null || typeof root !== "object" || Array.isArray(root)) throw new TypeError("Not an endpoint report.");
    const r = root as Record<string, unknown>;
    const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
    const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
    const w = (r["watermark"] ?? {}) as Record<string, unknown>;
    const server = text(r["server"]);
    const status = text(w["status"]);
    const checked = Date.parse(text(r["checkedAt"]));
    return new EndpointReport({
      baseUrl: text(r["baseUrl"]),
      model: text(r["model"]),
      checkedAt: Number.isNaN(checked) ? 0 : checked,
      server: SERVERS.has(server) ? (server as EndpointServer) : EndpointServer.Unknown,
      serverVersion: textOrNull(r["serverVersion"]),
      dialect: text(r["dialect"], EndpointDialect.openAiCompatible.name),
      reachable: r["reachable"] === true,
      keyAccepted: flag(r["keyAccepted"]),
      models: Array.isArray(r["models"]) ? r["models"].filter((m): m is string => typeof m === "string") : [],
      chat: flag(r["chat"]),
      usage: flag(r["usage"]),
      toolCalls: flag(r["toolCalls"]),
      vision: flag(r["vision"]),
      contextLength: count(r["contextLength"]),
      modelContextLength: count(r["modelContextLength"]),
      pictures: r["pictures"] === true,
      watermark: {
        status: WATERMARKS.has(status) ? (status as EndpointWatermarkStatus["status"]) : "Unknown",
        source: textOrNull(w["source"]),
        checked: textOrNull(w["checked"]),
        requested: w["requested"] === true,
        confirmed: flag(w["confirmed"]),
      },
      problems: Array.isArray(r["problems"]) ? r["problems"].filter((p): p is EndpointProblem => typeof p === "string" && PROBLEMS.has(p)) : [],
    });
  }
}

const PROBE_TOOL = "report_ready";

/** A one-pixel PNG for the vision probe. */
const ONE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Json = Record<string, unknown>;

/**
 * Checks an endpoint step by step (sdk/51 F03): `/models` (reachable, the key, the models), a one-token streamed chat (usage
 * figures), the tool-call probe (a dummy function with `tool_choice: "required"`), optionally a picture, the context length
 * (Ollama's `/api/show`, vLLM's `/models`, LM Studio's own API, or the person's setting), and the text watermark status from
 * the sourced table. Every request goes to the endpoint's own origin and nowhere else.
 *
 * There is **no local search** here (.NET's `FindLocalAsync`, which tries the loopback ports of Ollama, LM Studio, vLLM and
 * llama.cpp): a browser may not scan ports, so in TypeScript the check covers only the configured origin (F03).
 *
 * .NET: `EndpointCheck`.
 */
export class EndpointCheck {
  readonly #endpoint: ModelEndpoint;

  constructor(endpoint: ModelEndpoint) {
    this.#endpoint = endpoint;
  }

  async run(options: EndpointCheckOptions = {}): Promise<EndpointReport> {
    const endpoint = this.#endpoint;
    const signal = options.signal;
    const dialect = endpoint.dialect ?? EndpointDialect.openAiCompatible;
    const model = endpoint.model ?? "";
    const problems: EndpointProblem[] = [];
    let server = byHost(endpoint.baseUrl) ?? byDialect(dialect);
    let report: EndpointReportData = {
      baseUrl: String(endpoint.baseUrl), model, checkedAt: Date.now(), server, serverVersion: null, dialect: dialect.name,
      reachable: false, keyAccepted: null, models: [], chat: null, usage: null, toolCalls: null, vision: null,
      contextLength: null, modelContextLength: null, pictures: false,
      watermark: TextWatermarks.for(server, null, dialect.requestWatermark, null), problems: [],
    };
    const transport = new EndpointTransport(endpoint);

    // 1. /models: reachable, the key, the models.
    let listing: Json | undefined;
    try {
      const listed = await modelsWithRaw(transport, signal);
      listing = listed.raw;
      server = server === EndpointServer.Unknown ? recognise(listed.owner, server) : server;
      report = { ...report, reachable: true, keyAccepted: true, models: listed.models, server };
      if (listed.models.length > 0 && model.length > 0 && !listed.models.includes(model)) problems.push(EndpointProblem.ModelNotFound);
    } catch (e) {
      if (e instanceof EndpointNotCompatibleError) {
        report = { ...report, reachable: true }; // some servers have no /models; the chat decides
      } else {
        const stop = stopOf(e, problems);
        if (!stop) throw e;
        return finish({ ...report, reachable: stop.reachable, keyAccepted: stop.keyAccepted }, problems);
      }
    }

    // The server's version where it says (vLLM's and SGLang's /version), for the watermark table.
    let version: string | null = null;
    if (server === EndpointServer.Vllm || server === EndpointServer.Sglang) version = await versionOf(transport, signal);

    // 2. A one-token streamed chat: does it answer, do usage figures come back?
    let client = new DirectChatClient(endpoint, transport);
    let watermarkRequested = dialect.requestWatermark;
    let confirmed: boolean | null = null;
    try {
      const probe = await probeChat(client, signal);
      confirmed = probe.confirmed;
      report = { ...report, reachable: true, keyAccepted: true, chat: true, usage: probe.usage };
      if (!probe.usage) problems.push(EndpointProblem.NoUsage);
    } catch (e) {
      if (watermarkRequested && e instanceof FadenstackApiError && (e.status === 400 || e.status === 422) && mentions(e, "watermark")) {
        // The server refused the request for its mark (not configured): requests go without it, the report says so.
        watermarkRequested = false;
        problems.push(EndpointProblem.WatermarkRequestRefused);
        const without: ModelEndpoint = { ...endpoint, dialect: { ...dialect, requestWatermark: false } };
        client = new DirectChatClient(without, new EndpointTransport(without));
        try {
          const probe = await probeChat(client, signal);
          confirmed = probe.confirmed;
          report = { ...report, reachable: true, keyAccepted: true, chat: true, usage: probe.usage };
        } catch (again) {
          const stop = stopOf(again, problems);
          if (!stop) throw again;
          return finish({ ...report, reachable: stop.reachable, keyAccepted: stop.keyAccepted, chat: false }, problems, version, watermarkRequested, confirmed);
        }
      } else {
        const stop = stopOf(e, problems);
        if (!stop) throw e;
        return finish({ ...report, reachable: stop.reachable, keyAccepted: stop.keyAccepted, chat: false }, problems, version, watermarkRequested, confirmed);
      }
    }

    // 3. The tool-call probe.
    try {
      report = { ...report, toolCalls: await probeTools(client, signal) };
    } catch (e) {
      if (e instanceof FadenstackApiError && (e.status === 400 || e.status === 422 || e.status === 500)) {
        report = { ...report, toolCalls: false }; // "does not support tools"
      } else {
        throw e;
      }
    }
    if (report.toolCalls === false) problems.push(EndpointProblem.NoToolCalls);

    // 4. A picture, when asked for.
    if (options.probeVision) {
      try {
        const picture: ChatMessage = { role: "user", content: [
          { type: "text", text: "What colour is this picture? One word." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${ONE_PIXEL}` } },
        ] };
        await client.complete([picture], withSignal({ maxTokens: 8 }, signal));
        report = { ...report, vision: true };
      } catch (e) {
        if (!(e instanceof FadenstackApiError)) throw e;
        report = { ...report, vision: false };
      }
    }

    // 5. The context length.
    const { running, maximum } = await contextOf(transport, model, server, listing, signal);
    const context = options.contextLength ?? running;
    report = { ...report, contextLength: context, modelContextLength: maximum };
    if (server === EndpointServer.Ollama && options.contextLength === undefined && running === null) problems.push(EndpointProblem.OllamaDefaultContext);
    const have = context ?? maximum;
    if (options.requiredContextTokens !== undefined && have !== null && have < options.requiredContextTokens) problems.push(EndpointProblem.ContextTooShort);
    return finish(report, problems, version, watermarkRequested, confirmed);
  }
}

function finish(report: EndpointReportData, problems: EndpointProblem[], version?: string | null, requested?: boolean, confirmed?: boolean | null): EndpointReport {
  return new EndpointReport({
    ...report,
    serverVersion: version ?? report.serverVersion,
    watermark: TextWatermarks.for(report.server, version, requested ?? report.watermark.requested, confirmed),
    problems: [...new Set(problems)],
    pictures: false, // standalone has no pictures until D17 (owner, 14 Nov)
  });
}

/** The problem an error means, and whether the check goes on; undefined for an error the check does not know. */
function stopOf(e: unknown, problems: EndpointProblem[]): { reachable: boolean; keyAccepted: boolean | null } | undefined {
  const add = (problem: EndpointProblem, reachable: boolean, keyAccepted: boolean | null) => {
    problems.push(problem);
    return { reachable, keyAccepted };
  };
  if (e instanceof EndpointUnreachableError) return add(EndpointProblem.Unreachable, false, null);
  if (e instanceof ServerCertificateError) return add(EndpointProblem.CertificateNotTrusted, false, null);
  if (e instanceof EndpointPlainHttpRefusedError) return add(EndpointProblem.PlainHttpRefused, false, null);
  if (e instanceof EndpointKeyRejectedError) return add(EndpointProblem.KeyRejected, true, false);
  if (e instanceof EndpointOriginRefusedError) return add(EndpointProblem.OriginRefused, true, null);
  if (e instanceof EndpointModelNotFoundError) return add(EndpointProblem.ModelNotFound, true, true);
  if (e instanceof EndpointNotCompatibleError) return add(EndpointProblem.NotCompatible, true, null);
  if (e instanceof FadenstackRateLimitedError) return add(EndpointProblem.RateLimited, true, true);
  if (e instanceof FadenstackError) return add(EndpointProblem.Failed, true, null);
  return undefined;
}

const mentions = (e: FadenstackApiError, word: string): boolean =>
  e.message.toLowerCase().includes(word) || (e.code?.toLowerCase().includes(word) ?? false);

const withSignal = (options: ChatOptions, signal: AbortSignal | undefined): ChatOptions => (signal ? { ...options, signal } : options);

async function probeChat(client: DirectChatClient, signal: AbortSignal | undefined): Promise<{ usage: boolean; confirmed: boolean | null }> {
  let usage = false;
  let confirmed: boolean | null = null;
  for await (const update of client.stream([{ role: "user", content: "Reply with OK." }], withSignal({ maxTokens: 1 }, signal))) {
    if (update.type === "usage") usage = true;
    if (update.type === "endpoint_marking") confirmed = update.marking.confirmed ?? null;
  }
  return { usage, confirmed };
}

async function probeTools(client: DirectChatClient, signal: AbortSignal | undefined): Promise<boolean> {
  const options = withSignal({
    tools: [{ name: PROBE_TOOL, description: "Reports that the assistant is ready. Call it now.", parameters: { type: "object", properties: {} } }],
    toolChoice: "required", maxTokens: 256, reasoningEffort: "none",
  }, signal);
  for await (const update of client.stream([{ role: "user", content: `Call the tool ${PROBE_TOOL} now, with no arguments.` }], options)) {
    if (update.type === "tool_calls" && update.calls.some((c) => c.name === PROBE_TOOL)) return true;
  }
  return false;
}

async function modelsWithRaw(transport: EndpointTransport, signal: AbortSignal | undefined): Promise<{ models: string[]; owner: string | undefined; raw: Json }> {
  const json = await getJson(transport, endpointModels(transport.base), signal);
  const data = isObject(json) ? json["data"] : undefined;
  if (!isObject(json) || !Array.isArray(data)) throw new EndpointNotCompatibleError(200, "The endpoint's /models is not an OpenAI model list.");
  const models: string[] = [];
  let owner: string | undefined;
  for (const model of data) {
    if (isObject(model) && typeof model["id"] === "string") {
      models.push(model["id"]);
      owner ??= typeof model["owned_by"] === "string" ? model["owned_by"] : undefined;
    }
  }
  return { models, owner, raw: json };
}

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

async function getJson(transport: EndpointTransport, url: URL, signal: AbortSignal | undefined, body?: unknown): Promise<unknown> {
  const { response, text } = await transport.request(url, () => ({
    method: body === undefined ? "GET" : "POST",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) } as Record<string, string>,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), signal);
  if (!response.ok) throw toEndpointError(response, text, transport.endpoint.key !== undefined);
  try {
    return JSON.parse(text);
  } catch {
    throw new EndpointNotCompatibleError(response.status, "The endpoint's answer is not JSON.");
  }
}

async function versionOf(transport: EndpointTransport, signal: AbortSignal | undefined): Promise<string | null> {
  try {
    const json = await getJson(transport, endpointRoot(transport.base, "version"), signal);
    return isObject(json) && typeof json["version"] === "string" ? json["version"] : null;
  } catch (e) {
    if (e instanceof FadenstackError) return null;
    throw e;
  }
}

const int32 = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 2_147_483_647 ? v : null);

/** The running context length and the model's maximum, where the server says. */
async function contextOf(transport: EndpointTransport, model: string, server: EndpointServer, listing: Json | undefined, signal: AbortSignal | undefined):
  Promise<{ running: number | null; maximum: number | null }> {
  const none = { running: null, maximum: null };
  try {
    switch (server) {
      case EndpointServer.Ollama: {
        const show = await getJson(transport, endpointRoot(transport.base, "api/show"), signal, { model });
        if (!isObject(show)) return none;
        let maximum: number | null = null;
        const info = show["model_info"];
        if (isObject(info)) {
          for (const [name, value] of Object.entries(info)) {
            if (name.endsWith(".context_length") && int32(value) !== null) maximum = int32(value);
          }
        }
        let running: number | null = null;
        const parameters = show["parameters"];
        if (typeof parameters === "string") {
          for (const line of parameters.split("\n")) {
            const parts = line.split(/[ \t]+/).filter((p) => p !== "");
            if (parts.length === 2 && parts[0] === "num_ctx" && /^[+-]?\d+$/.test(parts[1]!)) running = Number.parseInt(parts[1]!, 10);
          }
        }
        return { running, maximum };
      }
      case EndpointServer.Vllm:
      case EndpointServer.Sglang: {
        if (!listing) return none;
        const data = listing["data"];
        for (const entry of Array.isArray(data) ? data : []) {
          if (isObject(entry) && entry["id"] === model && int32(entry["max_model_len"]) !== null) {
            const n = int32(entry["max_model_len"]);
            return { running: n, maximum: n }; // the server runs with it
          }
        }
        return none;
      }
      case EndpointServer.LMStudio: {
        const escaped = encodeURIComponent(model).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        const info = await getJson(transport, endpointRoot(transport.base, `api/v0/models/${escaped}`), signal);
        const read = (name: string): number | null => (isObject(info) ? int32(info[name]) : null);
        return { running: read("loaded_context_length"), maximum: read("max_context_length") };
      }
      default:
        return none;
    }
  } catch (e) {
    if (e instanceof FadenstackError) return none;
    throw e;
  }
}

/** The server by the endpoint's host, for the clouds whose host says it. */
export function byHost(baseUrl: string | URL): EndpointServer | undefined {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("api.openai.com")) return EndpointServer.OpenAI;
  if (is("openai.azure.com") || is("cognitiveservices.azure.com") || is("services.ai.azure.com")) return EndpointServer.AzureOpenAI;
  if (is("api.anthropic.com")) return EndpointServer.Anthropic;
  if (is("api.x.ai")) return EndpointServer.XAi;
  if (is("generativelanguage.googleapis.com")) return EndpointServer.Google;
  if (is("api.mistral.ai")) return EndpointServer.Mistral;
  if (is("openrouter.ai")) return EndpointServer.OpenRouter;
  return undefined;
}

function byDialect(dialect: EndpointDialect): EndpointServer {
  switch (dialect.name) {
    case "openai": return EndpointServer.OpenAI;
    case "azure-openai": return EndpointServer.AzureOpenAI;
    case "ollama": return EndpointServer.Ollama;
    case "lm-studio": return EndpointServer.LMStudio;
    case "vllm": return EndpointServer.Vllm;
    case "sglang": return EndpointServer.Sglang;
    case "llama.cpp": return EndpointServer.LlamaCpp;
    case "litellm": return EndpointServer.LiteLlm;
    case "openrouter": return EndpointServer.OpenRouter;
    case "mistral": return EndpointServer.Mistral;
    default: return EndpointServer.Unknown;
  }
}

/** The server by `/models`' `owned_by`, where it says one. */
function recognise(owner: string | undefined, fallback: EndpointServer): EndpointServer {
  switch (owner?.toLowerCase()) {
    case "vllm": return EndpointServer.Vllm;
    case "sglang": return EndpointServer.Sglang;
    case "llamacpp": case "llama.cpp": return EndpointServer.LlamaCpp;
    default: return fallback;
  }
}
