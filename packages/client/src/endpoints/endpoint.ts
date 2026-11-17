import type { TokenProvider } from "../auth/tokens.js";
import type { FetchLike } from "../http/transport.js";
import type { FadenstackLogger } from "../logging.js";

/**
 * The person's own model endpoint, for standalone mode (sdk/51 F03): any server that speaks the OpenAI chat completions API,
 * such as Ollama, LM Studio, vLLM, an OpenAI-compatible cloud. .NET: `ModelEndpoint`.
 *
 * The transport rules (OWASP ASVS 5.0 V12, V13): https, or plain http to this device (loopback); plain http to a private
 * network only with `allowPlainHttpInLan`; a key never over plain http; no redirect to another origin.
 */
export interface ModelEndpoint {
  /** The base, including `/v1` (the OpenAI convention): `http://localhost:11434/v1`. */
  baseUrl: string | URL;
  /** The model's id on that server (`qwen3:14b`); `ChatOptions.model` overrides it per request. */
  model?: string;
  /**
   * Where the key comes from (the app's own store, `chrome.storage` with a WebCrypto key); undefined for a server without
   * one. It never goes over plain http. The SDK never stores a key.
   */
  key?: TokenProvider;
  /** What the server expects where servers differ (a preset or the check gives it). Default: `EndpointDialect.openAiCompatible`. */
  dialect?: EndpointDialect;
  /**
   * Plain http to a private network (RFC 1918, link-local, fc00::/7; in a browser also a single-label name or one ending in
   * `.local`, `.lan`, `.home.arpa`, `.internal`), after the person opted in for this endpoint and saw the warning (D3). Never
   * with a key; a machine policy can forbid it (F09).
   */
  allowPlainHttpInLan?: boolean;
  /**
   * The machine policy forbids plain http in the local network (F09): such a request is refused, saying so
   * (`EndpointPlainHttpRefusedError`, reason `forbiddenByPolicy`). `AgentBuilder.useMachinePolicy` sets it, together with
   * `allowPlainHttpInLan: false`; an app has no reason to. .NET: internal `PlainHttpForbidden`.
   */
  plainHttpForbidden?: boolean;
  /** How long a request may take, in ms (default 5 min); for a streamed answer, the wait for its headers. */
  timeoutMs?: number;
  /** How long a streamed answer may send nothing at all before it is given up, in ms (default 5 min; `Infinity` turns it off). */
  streamIdleTimeoutMs?: number;
  /**
   * The `fetch` requests go through instead of the global one (tests, a host's proxy). The SDK still applies the transport
   * rules and always asks for `redirect: "manual"`.
   */
  fetch?: FetchLike;
  /** Where requests are logged (method, route, status, duration; never content or the key). Default: nowhere. */
  logger?: FadenstackLogger;
}

/** Which field caps an answer's length. The strings are .NET's `MaxTokensField` names, so settings travel between the SDKs. */
export type MaxTokensField =
  /** `max_tokens`: most servers. */
  | "MaxTokens"
  /** `max_completion_tokens`: OpenAI and Azure OpenAI, whose reasoning models refuse `max_tokens`. */
  | "MaxCompletionTokens";

/** How the request says how much the model reasons (`ChatOptions.reasoningEffort`). */
export type ThinkingSwitch =
  /** Not sent: the model's own default. */
  | "None"
  /** OpenAI's `reasoning_effort` (`none`, `low`, `medium`, `high`). */
  | "ReasoningEffort"
  /**
   * The chat template's own switch, `chat_template_kwargs.enable_thinking` (Qwen and others on vLLM, SGLang, llama.cpp):
   * `false` for no reasoning, `true` for any level.
   */
  | "ChatTemplateKwargs";

/**
 * How a request asks a server to leave its text watermark off; sent only for calls no person reads (`ChatOptions.unread`,
 * F10). The strings are .NET's `WatermarkSwitchOff` names.
 */
export type WatermarkSwitchOff =
  /** The server has no such switch, or the SDK never sends it. */
  | "None"
  /** `watermarking: false`: vLLM (0.30+) and TensorRT-LLM. */
  | "WatermarkingFalse"
  /** `watermark: {"enabled": false}`: SGLang (0.5.22+). */
  | "WatermarkEnabledFalse";

/** Which header carries the key. */
export type KeyHeader =
  /** `Authorization: Bearer {key}`. */
  | "Bearer"
  /** `api-key: {key}`: Azure OpenAI's API keys. */
  | "ApiKey";

/**
 * What a kind of OpenAI-compatible server expects in a chat request where they differ (sdk/51 F03): the length field, the
 * thinking switch, whether a stream may ask for usage figures, the key's header, and whether the request asks for the
 * server's text watermark. A preset or the endpoint check picks one; an app may keep it with the endpoint. A plain object:
 * make a variant with a spread (`{ ...EndpointDialect.sglang, requestWatermark: false }`). .NET: `EndpointDialect`.
 */
export interface EndpointDialect {
  /** The dialect's name, as kept in settings: `openai`, `ollama`, `vllm`, ... */
  readonly name: string;
  readonly maxTokens: MaxTokensField;
  readonly thinking: ThinkingSwitch;
  /** Whether a streamed request sends `stream_options.include_usage` (servers that refuse unknown fields may not take it). */
  readonly streamUsage: boolean;
  readonly keyHeader: KeyHeader;
  /** Whether `reasoning_effort` may say `xhigh`; elsewhere the highest level is sent as `high`. */
  readonly extraHighEffort: boolean;
  /**
   * Whether every request for text people read asks the server for its text watermark: SGLang's per-request `watermark`
   * setting (`{"enabled": true}`; part of D18, owner 14 Nov). Other servers mark, or not, by their own configuration.
   */
  readonly requestWatermark: boolean;
  /**
   * How a request for an answer no person reads (`ChatOptions.unread`) asks the server to leave its watermark off. Never
   * sent for text people read (owner, 14 Nov; part of D18).
   */
  readonly watermarkSwitchOff: WatermarkSwitchOff;
  /**
   * The check found that the model thinks although the off switch was sent (gpt-oss ignores `reasoning_effort: "none"`; it knows
   * only low, medium and high). With a `ReasoningEffort` switch, Off then sends `low`, the lowest level the model has; a
   * `ChatTemplateKwargs` switch has no lower level and still sends the off switch. Set from the check's report
   * (`EndpointReport.thinksWhenOff`); absent means no. .NET: `EndpointDialect.ThinksWhenOff`.
   */
  readonly thinksWhenOff?: boolean;
}

const dialect = (name: string, changes: Partial<EndpointDialect> = {}): EndpointDialect =>
  Object.freeze({
    name, maxTokens: "MaxTokens", thinking: "None", streamUsage: true, keyHeader: "Bearer", extraHighEffort: false, requestWatermark: false,
    watermarkSwitchOff: "None",
    ...changes,
  } satisfies EndpointDialect);

const openAiCompatible = dialect("openai-compatible");
const openAi = dialect("openai", { maxTokens: "MaxCompletionTokens", thinking: "ReasoningEffort", extraHighEffort: true });
const azureOpenAi = dialect("azure-openai", { maxTokens: "MaxCompletionTokens", thinking: "ReasoningEffort", keyHeader: "ApiKey", extraHighEffort: true });
const ollama = dialect("ollama", { thinking: "ReasoningEffort" });
const lmStudio = dialect("lm-studio");
const vllm = dialect("vllm", { thinking: "ChatTemplateKwargs", watermarkSwitchOff: "WatermarkingFalse" });
const sglang = dialect("sglang", { thinking: "ChatTemplateKwargs", requestWatermark: true, watermarkSwitchOff: "WatermarkEnabledFalse" });
const llamaCpp = dialect("llama.cpp", { thinking: "ChatTemplateKwargs" });
const liteLlm = dialect("litellm", { thinking: "ReasoningEffort" });
const openRouter = dialect("openrouter", { thinking: "ReasoningEffort" });
const mistral = dialect("mistral", { streamUsage: false }); // Mistral's API refuses fields it does not know: no usage request

const allDialects: readonly EndpointDialect[] = Object.freeze([
  openAiCompatible, openAi, azureOpenAi, ollama, lmStudio, vllm, sglang, llamaCpp, liteLlm, openRouter, mistral,
]);

/** The built-in dialects. */
export const EndpointDialect = Object.freeze({
  /** Any server that speaks the OpenAI chat completions API: nothing beyond the common fields. */
  openAiCompatible,
  openAi,
  /** Azure OpenAI's v1 API (`https://{resource}.openai.azure.com/openai/v1`) with an API key. */
  azureOpenAi,
  ollama,
  lmStudio,
  vllm,
  sglang,
  llamaCpp,
  liteLlm,
  openRouter,
  /** Mistral's API, which refuses fields it does not know: no thinking switch, no usage request. */
  mistral,
  /** Every built-in dialect. */
  all: allDialects,
  /** The built-in dialect of that name (case does not matter), or the plain OpenAI-compatible one when there is none. */
  named(name: string | undefined | null): EndpointDialect {
    const wanted = (name ?? "").toLowerCase();
    return allDialects.find((d) => d.name.toLowerCase() === wanted) ?? openAiCompatible;
  },
});

/**
 * The kind of server behind an endpoint, as far as the SDK can tell; it decides the watermark status (F03 item 8). The
 * strings are .NET's `EndpointServer` names.
 */
export const EndpointServer = Object.freeze({
  Unknown: "Unknown",
  OpenAI: "OpenAI",
  AzureOpenAI: "AzureOpenAI",
  Anthropic: "Anthropic",
  XAi: "XAi",
  Google: "Google",
  Mistral: "Mistral",
  OpenRouter: "OpenRouter",
  LiteLlm: "LiteLlm",
  Ollama: "Ollama",
  LMStudio: "LMStudio",
  LlamaCpp: "LlamaCpp",
  LocalAI: "LocalAI",
  Vllm: "Vllm",
  Sglang: "Sglang",
} as const);
export type EndpointServer = (typeof EndpointServer)[keyof typeof EndpointServer];

/**
 * A ready-made endpoint (sdk/51 F03): its base and dialect, and whether it needs a key. The connection wizard (F15) offers
 * them. (.NET also has a local search over the `local` ones; a browser has none, see `EndpointCheck`.)
 */
export interface EndpointPreset {
  /** Kept in settings: `ollama`, `azure-openai`, ... */
  readonly id: string;
  /** The product's own name (not translated). */
  readonly name: string;
  /** The usual base; undefined where it is the person's own (Azure's resource, LiteLLM's host). */
  readonly baseUrl?: string;
  readonly dialect: EndpointDialect;
  readonly server: EndpointServer;
  readonly needsKey: boolean;
  /** A server on this computer. */
  readonly local: boolean;
}

const preset = (p: Omit<EndpointPreset, "needsKey" | "local"> & { needsKey?: boolean; local?: boolean }): EndpointPreset =>
  Object.freeze({ needsKey: false, local: false, ...p });

const presetOpenAi = preset({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", dialect: openAi, server: EndpointServer.OpenAI, needsKey: true });
const presetAzure = preset({ id: "azure-openai", name: "Azure OpenAI", dialect: azureOpenAi, server: EndpointServer.AzureOpenAI, needsKey: true });
const presetOllama = preset({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", dialect: ollama, server: EndpointServer.Ollama, local: true });
const presetLmStudio = preset({ id: "lm-studio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", dialect: lmStudio, server: EndpointServer.LMStudio, local: true });
const presetVllm = preset({ id: "vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", dialect: vllm, server: EndpointServer.Vllm, local: true });
const presetSglang = preset({ id: "sglang", name: "SGLang", baseUrl: "http://localhost:30000/v1", dialect: sglang, server: EndpointServer.Sglang });
const presetLlamaCpp = preset({ id: "llama.cpp", name: "llama.cpp", baseUrl: "http://localhost:8080/v1", dialect: llamaCpp, server: EndpointServer.LlamaCpp, local: true });
const presetLiteLlm = preset({ id: "litellm", name: "LiteLLM", dialect: liteLlm, server: EndpointServer.LiteLlm, needsKey: true });
const presetOpenRouter = preset({ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", dialect: openRouter, server: EndpointServer.OpenRouter, needsKey: true });
const presetMistral = preset({ id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", dialect: mistral, server: EndpointServer.Mistral, needsKey: true });

const allPresets: readonly EndpointPreset[] = Object.freeze([
  presetOpenAi, presetAzure, presetOllama, presetLmStudio, presetVllm, presetSglang, presetLlamaCpp, presetLiteLlm, presetOpenRouter, presetMistral,
]);

/** The built-in presets. */
export const EndpointPreset = Object.freeze({
  openAi: presetOpenAi,
  /** Azure OpenAI's v1 API: `https://{resource}.openai.azure.com/openai/v1`. */
  azureOpenAi: presetAzure,
  ollama: presetOllama,
  lmStudio: presetLmStudio,
  vllm: presetVllm,
  sglang: presetSglang,
  llamaCpp: presetLlamaCpp,
  liteLlm: presetLiteLlm,
  openRouter: presetOpenRouter,
  mistral: presetMistral,
  all: allPresets,
  /** The preset of that id (case does not matter), or undefined. */
  named(id: string | undefined | null): EndpointPreset | undefined {
    const wanted = (id ?? "").toLowerCase();
    return allPresets.find((p) => p.id.toLowerCase() === wanted);
  },
});
