import { FadenStreamError } from "../errors.js";
import { readNotice, type GovernanceNotice } from "../governance.js";
import { parseError, toApiError } from "../http/errorReader.js";
import type { FadenTransport, RequestSpec } from "../http/transport.js";
import { TOOL_MODE_HEADER, type ToolMode } from "../tools/toolModes.js";
import { readSse, type SseEvent } from "./sse.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamer,
  ChatUpdate,
  FadenEvent,
  FinishReason,
  ToolCall,
  Usage,
} from "./types.js";

export interface ChatClientSettings {
  /** The agent this client works for: chat goes to `/v1/agents/{agent}/chat/completions`. */
  agent?: string;
  model?: string;
  toolMode: ToolMode;
  /** Ask for the gateway's events (`X-Faden-Events: ag-ui`). */
  gatewayEvents: boolean;
}

type Json = Record<string, unknown>;

/**
 * The gateway's chat completions, over `fetch` -- not the OpenAI SDK: the gateway's events (tool rounds,
 * approvals, notices) arrive as `event` updates, and a refused prompt or answer as a `refused` update, not
 * an error. For an agent it calls `/v1/agents/{agent}/chat/completions`; otherwise `/v1/chat/completions`.
 */
export class FadenChatClient implements ChatStreamer {
  readonly endpoint: URL;
  readonly #transport: FadenTransport;
  readonly #settings: ChatClientSettings;

  constructor(transport: FadenTransport, settings: ChatClientSettings) {
    this.#transport = transport;
    this.#settings = settings;
    this.endpoint = settings.agent
      ? transport.gateway(`v1/agents/${encodeURIComponent(settings.agent)}/chat/completions`)
      : transport.gateway("v1/chat/completions");
  }

  /** The whole answer at once. */
  async complete(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body = JSON.stringify(requestBody(messages, options, this.#model(options), false));
    const { response, text } = await this.#transport.request(() => this.#build(body, options), options.signal);
    if (!response.ok) {
      const refused = refusal(response, text);
      if (refused) return { text: "", reasoning: "", toolCalls: [], events: [], refused, finishReason: "content_filter" };
      throw toApiError(response, text);
    }
    return toResponse(JSON.parse(text) as Json);
  }

  /** The answer as it streams: text, reasoning, whole tool calls, the gateway's events, usage, the finish. */
  async *stream(messages: readonly ChatMessage[], options: ChatOptions = {}): AsyncGenerator<ChatUpdate> {
    const body = JSON.stringify(requestBody(messages, options, this.#model(options), true));
    const response = await this.#transport.open(() => this.#build(body, options), options.signal);
    if (!response.ok) {
      const text = await response.text();
      const refused = refusal(response, text);
      if (!refused) throw toApiError(response, text);
      yield { type: "refused", notice: refused };
      yield { type: "finish", reason: "content_filter" };
      return;
    }
    if (!response.body) throw new FadenStreamError("The answer had no body.");
    const assembler = new StreamAssembler();
    for await (const sse of readSse(response.body, options.signal)) {
      yield* assembler.read(sse);
      if (assembler.done) break;
    }
    yield* assembler.flush();
  }

  #model(options: ChatOptions): string {
    const model = options.model ?? this.#settings.model ?? (this.#settings.agent ? "agent" : undefined);
    // An agent's model is the agent's; the field is required by the API, so it says "agent".
    if (!model) throw new TypeError("Set the client's model or ChatOptions.model.");
    return model;
  }

  #build(body: string, options: ChatOptions): RequestSpec {
    const headers: Record<string, string> = {
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      [TOOL_MODE_HEADER]: options.toolMode ?? this.#settings.toolMode,
    };
    if (this.#settings.gatewayEvents) headers["X-Faden-Events"] = "ag-ui";
    if (options.conversationId) headers["X-Faden-Conversation-Id"] = options.conversationId;
    if (options.turnId) headers["X-Faden-Turn-Id"] = options.turnId;
    return { method: "POST", url: this.endpoint, headers, body };
  }
}

/** The request body in the OpenAI shape, with the gateway's own fields. */
export function requestBody(messages: readonly ChatMessage[], options: ChatOptions, model: string, stream: boolean): Json {
  const body: Json = { model, messages };
  if (stream) {
    body["stream"] = true;
    body["stream_options"] = { include_usage: true };
  }
  const put = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  put("temperature", options.temperature);
  put("top_p", options.topP);
  put("max_tokens", options.maxTokens);
  put("seed", options.seed);
  if (options.stop?.length) body["stop"] = options.stop;
  // OpenAI's field; the gateway turns "none" into a vLLM template's own switch (Qwen's enable_thinking).
  put("reasoning_effort", options.reasoningEffort);
  if (options.responseFormat) {
    body["response_format"] = options.responseFormat.type === "json_schema"
      ? { type: "json_schema", json_schema: { name: options.responseFormat.name ?? "response", schema: options.responseFormat.schema } }
      : { type: "json_object" };
  }
  if (options.tools?.length) {
    body["tools"] = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    }));
    const choice = options.toolChoice;
    if (choice) {
      body["tool_choice"] = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
    }
  }
  put("session_id", options.sessionId);
  if (options.skills?.length) body["skills"] = options.skills;
  for (const [key, value] of Object.entries(options.extra ?? {})) body[key] = value;
  return body;
}

/** A prompt the gateway refused (422 `policy_blocked`) is an answer, not an error. */
function refusal(response: Response, body: string): GovernanceNotice | undefined {
  if (response.status !== 422) return undefined;
  const parsed = parseError(body, "The prompt was refused.");
  if (parsed.code !== "policy_blocked") return undefined;
  const notice: GovernanceNotice = parsed.faden?.["governance"]
    ? readNotice(parsed.faden["governance"])
    : { outcome: "prompt_blocked", stage: "input", message: parsed.message };
  if (!notice.outcome) notice.outcome = "prompt_blocked";
  if (!notice.message) notice.message = parsed.message;
  return notice;
}

const str = (o: unknown, key: string): string | undefined => {
  const v = o && typeof o === "object" ? (o as Json)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

export function toFadenEvent(raw: Json): FadenEvent {
  const event: FadenEvent = { type: str(raw, "type") ?? "", raw };
  const name = str(raw, "name");
  if (name !== undefined) event.name = name;
  if ("value" in raw) event.value = raw["value"];
  return event;
}

export function toolCall(id: string, name: string, argumentsJson: string): ToolCall {
  const call: ToolCall = { id, name, argumentsJson, arguments: undefined };
  if (argumentsJson.trim() === "") {
    call.arguments = {};
    return call;
  }
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) call.arguments = parsed as Json;
    else call.argumentsError = "Tool arguments are not a JSON object.";
  } catch (error) {
    call.argumentsError = (error as Error).message;
  }
  return call;
}

function usage(root: Json): Usage | undefined {
  const u = root["usage"];
  if (!u || typeof u !== "object") return undefined;
  const n = (key: string) => (typeof (u as Json)[key] === "number" ? ((u as Json)[key] as number) : 0);
  const result: Usage = { promptTokens: n("prompt_tokens"), completionTokens: n("completion_tokens"), totalTokens: n("total_tokens") };
  const details = (u as Json)["prompt_tokens_details"];
  const cached = details && typeof details === "object" ? (details as Json)["cached_tokens"] : undefined;
  if (typeof cached === "number") result.cachedPromptTokens = cached;
  return result;
}

function toResponse(root: Json): ChatResponse {
  const response: ChatResponse = { text: "", reasoning: "", toolCalls: [], events: [] };
  const id = str(root, "id");
  const model = str(root, "model");
  if (id) response.id = id;
  if (model) response.model = model;
  const faden = root["faden"] as Json | undefined;
  if (faden && Array.isArray(faden["events"])) {
    response.events = (faden["events"] as Json[]).filter((e) => e && typeof e === "object").map(toFadenEvent);
  }
  const choice = Array.isArray(root["choices"]) ? (root["choices"] as Json[])[0] : undefined;
  if (choice) {
    const finish = str(choice, "finish_reason");
    if (finish) response.finishReason = finish;
    const message = choice["message"] as Json | undefined;
    if (message) {
      response.reasoning = str(message, "reasoning_content") ?? str(message, "reasoning") ?? "";
      response.text = str(message, "content") ?? "";
      if (Array.isArray(message["tool_calls"])) {
        response.toolCalls = (message["tool_calls"] as Json[]).map((c) => {
          const fn = (c["function"] ?? {}) as Json;
          return toolCall(str(c, "id") ?? "", str(fn, "name") ?? "", str(fn, "arguments") ?? "");
        });
      }
    }
  }
  const u = usage(root);
  if (u) response.usage = u;
  if (faden?.["governance"]) {
    response.refused = readNotice(faden["governance"]);
    response.finishReason = "content_filter";
  }
  return response;
}

/** Turns the chunks of a stream into updates; tool calls come out whole, at their end. */
class StreamAssembler {
  done = false;
  readonly #calls = new Map<number, { id: string; name: string; args: string }>();
  #responseId: string | undefined;
  #model: string | undefined;

  *read(sse: SseEvent): Generator<ChatUpdate> {
    if (sse.name === "faden") {
      let raw: Json;
      try {
        raw = JSON.parse(sse.data) as Json;
      } catch {
        return; // a malformed event is skipped, as clients that do not know it do
      }
      const event = toFadenEvent(raw);
      yield { type: "event", event };
      if (event.type === "CUSTOM" && event.name === "faden.governance" && event.value) {
        yield { type: "refused", notice: readNotice(event.value) };
      }
      return;
    }
    if (sse.data === "[DONE]") {
      this.done = true;
      return;
    }
    let root: Json;
    try {
      root = JSON.parse(sse.data) as Json;
    } catch {
      return;
    }
    const choices = Array.isArray(root["choices"]) ? (root["choices"] as Json[]) : [];
    const error = root["error"];
    if (error && typeof error === "object" && choices.length === 0) {
      throw new FadenStreamError(str(error, "message") ?? "The answer broke off.", str(error, "code"));
    }
    this.#responseId ??= str(root, "id");
    this.#model ??= str(root, "model");
    const u = usage(root);
    if (u) yield { type: "usage", usage: u };
    for (const choice of choices) {
      const delta = choice["delta"] as Json | undefined;
      if (delta) {
        const reasoning = str(delta, "reasoning_content") ?? str(delta, "reasoning");
        if (reasoning) yield { type: "reasoning", text: reasoning };
        const text = str(delta, "content");
        if (text) yield { type: "text", text };
        if (Array.isArray(delta["tool_calls"])) {
          for (const call of delta["tool_calls"] as Json[]) this.#collect(call);
        }
      }
      const finish = str(choice, "finish_reason");
      if (finish) {
        const calls = this.#takeCalls();
        if (calls.length) yield { type: "tool_calls", calls };
        yield this.#finish(finish);
      }
    }
  }

  *flush(): Generator<ChatUpdate> {
    const calls = this.#takeCalls();
    if (calls.length) yield { type: "tool_calls", calls };
  }

  #collect(call: Json): void {
    const index = typeof call["index"] === "number" ? (call["index"] as number) : 0;
    const entry = this.#calls.get(index) ?? { id: "", name: "", args: "" };
    const fn = (call["function"] ?? {}) as Json;
    entry.id = str(call, "id") || entry.id;
    entry.name = str(fn, "name") || entry.name;
    entry.args += str(fn, "arguments") ?? "";
    this.#calls.set(index, entry);
  }

  #takeCalls(): ToolCall[] {
    const calls = [...this.#calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => toolCall(c.id, c.name, c.args));
    this.#calls.clear();
    return calls;
  }

  #finish(reason: FinishReason): ChatUpdate {
    const update: ChatUpdate = { type: "finish", reason };
    if (this.#responseId) update.responseId = this.#responseId;
    if (this.#model) update.model = this.#model;
    return update;
  }
}
