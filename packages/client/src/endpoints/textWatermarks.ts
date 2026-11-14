import { EndpointServer } from "./endpoint.js";

/** Whether text from a connection carries the server's own watermark (F03 item 8; part of D18, owner 14 Nov). The strings are .NET's `TextWatermark` names. */
export const TextWatermark = Object.freeze({
  /** Nobody has documented it for this server, or it depends on a provider behind it. */
  Unknown: "Unknown",
  /** The provider marks text by default (Anthropic). */
  Marks: "Marks",
  /** Only when the account turned text watermarking on (OpenAI, xAI). */
  IfAccountEnabled: "IfAccountEnabled",
  /** Only when the server's operator configured it (vLLM 0.30+, SGLang 0.5.22+). */
  IfOperatorConfigured: "IfOperatorConfigured",
  /** The server has no text watermark (Ollama, llama.cpp, LM Studio, LocalAI; vLLM and SGLang before it). */
  Never: "Never",
} as const);
export type TextWatermark = (typeof TextWatermark)[keyof typeof TextWatermark];

/**
 * A connection's text watermark status, with the source it rests on; kept for the records (F10). .NET: `WatermarkStatus`
 * (named `EndpointWatermarkStatus` here: `WatermarkStatus` is already the provenance contract's type).
 */
export interface EndpointWatermarkStatus {
  status: TextWatermark;
  /** Where the status comes from: the provider's or project's own page. */
  source: string | null;
  /** When the source was read (ISO date). */
  checked: string | null;
  /** Whether every request for text people read asks for the mark (SGLang's per-request setting). */
  requested: boolean;
  /** What the server said of the check's answer, where it says (xAI's `x-watermark`); null: nothing. */
  confirmed: boolean | null;
}

type Version = readonly [number, number, number];
const VLLM_FIRST: Version = [0, 30, 0];
const SGLANG_FIRST: Version = [0, 5, 22];

/**
 * The sourced table by server type (sdk/51 F03 item 8), from fadenstack-dev `reports/AI Act marking in standalone tools.md`,
 * read 14 November 2026. Update the row and its source when a provider changes; never claim a mark the source does not give.
 * .NET: `TextWatermarks`.
 */
export const TextWatermarks = Object.freeze({
  /** When the sources were read. */
  checked: "2026-11-14",

  /** The status of a server type; `version` is the server's own, where it says (vLLM's and SGLang's `/version`). */
  for(server: EndpointServer, version: string | null | undefined, requested: boolean, confirmed: boolean | null | undefined): EndpointWatermarkStatus {
    const row = ((): [TextWatermark, string | null] => {
      switch (server) {
        case EndpointServer.Anthropic: return [TextWatermark.Marks, "https://support.claude.com/en/articles/16266773"];
        case EndpointServer.OpenAI:
          return [TextWatermark.IfAccountEnabled, "https://techcrunch.com/2026/10/05/openai-will-start-watermarking-chatgpts-text-in-the-eu/"];
        case EndpointServer.XAi: return [TextWatermark.IfAccountEnabled, "https://docs.x.ai/developers/advanced-api-usage/watermarking"];
        case EndpointServer.Vllm: return [atLeast(version, VLLM_FIRST), "https://docs.vllm.ai/en/latest/features/watermarking/"];
        case EndpointServer.Sglang: return [atLeast(version, SGLANG_FIRST), "https://docs.sglang.io/docs/advanced_features/text_watermarking"];
        // No watermark shipped (searched 14 Nov 2026): the projects' own pages.
        case EndpointServer.Ollama: return [TextWatermark.Never, "https://github.com/ollama/ollama"];
        case EndpointServer.LMStudio: return [TextWatermark.Never, "https://lmstudio.ai/docs/developer"];
        case EndpointServer.LocalAI: return [TextWatermark.Never, "https://github.com/mudler/LocalAI"];
        case EndpointServer.LlamaCpp: return [TextWatermark.Never, "https://github.com/ggml-org/llama.cpp/pull/28350"];
        case EndpointServer.AzureOpenAI:
          return [TextWatermark.Unknown, "https://learn.microsoft.com/azure/foundry/responsible-ai/content-safety/provenance-disclosure"];
        case EndpointServer.Google:
          return [TextWatermark.Unknown,
            "https://discuss.ai.google.dev/t/does-gemini-api-text-output-carry-synthid-watermarking-gemini-2-5-flash-lite-gemini-3-1-flash-lite-eu-ai-act-art-50-2/177241"];
        default: return [TextWatermark.Unknown, null]; // Mistral, OpenRouter, LiteLLM, unknown: none found, or the provider behind it decides
      }
    })();
    return { status: row[0], source: row[1], checked: TextWatermarks.checked, requested, confirmed: confirmed ?? null };
  },

  /** A version's first three numbers (`0.33.0rc1+cu130` is 0.33.0), or undefined when there are not two. */
  parse(version: string | null | undefined): Version | undefined {
    if (!version?.trim()) return undefined;
    const core = /^[vV]*([0-9.]*)/.exec(version.trim())?.[1] ?? "";
    const parts = core.split(".").filter((p) => p !== "");
    if (parts.length < 2) return undefined;
    const [major, minor, patch] = parts.map((p) => Number.parseInt(p, 10));
    if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return undefined;
    return [major, minor, patch === undefined || Number.isNaN(patch) ? 0 : patch];
  },
});

/** A known version before the first with the feature: never; at or after it, or unknown: only if configured. */
function atLeast(version: string | null | undefined, first: Version): TextWatermark {
  const v = TextWatermarks.parse(version);
  return v !== undefined && compare(v, first) < 0 ? TextWatermark.Never : TextWatermark.IfOperatorConfigured;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
