import { requestBody } from "../chat/chatClient.js";
import type { ChatMessage, ChatOptions, EndpointMarking } from "../chat/types.js";
import type { EndpointDialect } from "./endpoint.js";

/**
 * The extra request fields an app may pass through `ChatOptions.extra`: sampling knobs that many servers know. Nothing else
 * goes to the endpoint; in particular never a field that switches a watermark off (F10), and (review R2) never one that
 * could overwrite `model` or `messages`, which `requestBody` copies last.
 */
export const ENDPOINT_PASS_THROUGH: readonly string[] = Object.freeze(["top_k", "min_p", "repetition_penalty", "parallel_tool_calls"]);

/**
 * The chat request for a person's own endpoint: `requestBody`'s OpenAI shape, without anything that is the gateway's
 * (`session_id`, `skills`, any `faden.*` key, the message's `name`), and in the endpoint's dialect. .NET: `EndpointWire.Request`.
 */
export function endpointRequest(
  messages: readonly ChatMessage[],
  options: ChatOptions,
  model: string,
  stream: boolean,
  dialect: EndpointDialect,
): Record<string, unknown> {
  const body = requestBody(messages, cleanOptions(options), model, stream);
  if (!dialect.streamUsage) delete body["stream_options"];
  if (dialect.maxTokens === "MaxCompletionTokens" && body["max_tokens"] !== undefined) {
    body["max_completion_tokens"] = body["max_tokens"];
    delete body["max_tokens"];
  }
  const effort = typeof body["reasoning_effort"] === "string" ? body["reasoning_effort"] : undefined;
  delete body["reasoning_effort"];
  if (effort !== undefined) {
    if (dialect.thinking === "ReasoningEffort") {
      body["reasoning_effort"] = effort === "xhigh" && !dialect.extraHighEffort ? "high" : effort;
    } else if (dialect.thinking === "ChatTemplateKwargs") {
      body["chat_template_kwargs"] = { enable_thinking: effort !== "none" };
    }
  }
  if (Array.isArray(body["messages"])) {
    // The person's name stays on the device (data minimisation).
    body["messages"] = (body["messages"] as Record<string, unknown>[]).map((m) => {
      if (!("name" in m)) return m;
      const { name: _name, ...rest } = m;
      return rest;
    });
  }
  if (dialect.requestWatermark) body["watermark"] = { enabled: true };
  return body;
}

/** The options without the gateway's fields and without any extra key that is not passed through. */
function cleanOptions(options: ChatOptions): ChatOptions {
  const { sessionId: _session, skills: _skills, extra, ...rest } = options;
  const clean: ChatOptions = { ...rest };
  if (extra) {
    const kept: Record<string, unknown> = {};
    for (const key of ENDPOINT_PASS_THROUGH) if (extra[key] !== undefined) kept[key] = extra[key];
    if (Object.keys(kept).length > 0) clean.extra = kept;
  }
  return clean;
}

/**
 * Whether the request's sampling is deterministic (temperature 0, `top_k` 1), which defeats a text watermark (F10): the
 * record then says the endpoint's mark may not apply.
 */
export function isDeterministic(options: ChatOptions | undefined): boolean {
  if (options?.temperature === 0) return true;
  const k = options?.extra?.["top_k"];
  return (typeof k === "number" || typeof k === "string") && String(k).trim() !== "" && Number(k) === 1;
}

/** `x-watermark`'s value as a yes or no; undefined when the server said nothing or something else. */
export function parseWatermarkHeader(value: string | null | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case "true": case "1": case "yes": case "on": case "watermarked": case "applied":
      return true;
    case "false": case "0": case "no": case "off": case "none": case "not_applied":
      return false;
    default:
      return undefined;
  }
}

/** What an answer says about the watermark: the request, the `x-watermark` header and the sampling. */
export function endpointMarking(dialect: EndpointDialect, response: Response, options: ChatOptions | undefined): EndpointMarking {
  const marking: EndpointMarking = { requested: dialect.requestWatermark, deterministic: isDeterministic(options) };
  const confirmed = parseWatermarkHeader(response.headers.get("x-watermark"));
  if (confirmed !== undefined) marking.confirmed = confirmed;
  return marking;
}
