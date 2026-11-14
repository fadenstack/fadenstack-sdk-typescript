import { StreamAssembler, toResponse } from "../chat/chatClient.js";
import { readSse, SSE_ENDPOINT_LIMITS } from "../chat/sse.js";
import type { ChatMessage, ChatOptions, ChatResponse, ChatStreamer, ChatUpdate } from "../chat/types.js";
import type { ModelEndpoint } from "./endpoint.js";
import { EndpointNotCompatibleError } from "./endpointErrors.js";
import { EndpointTransport, textOf, toEndpointError, type EndpointRequest } from "./endpointTransport.js";
import { endpointChatCompletions } from "./endpointUrl.js";
import { endpointMarking, endpointRequest } from "./endpointWire.js";

type Json = Record<string, unknown>;

/**
 * A person's own OpenAI-compatible endpoint as a `ChatStreamer` (sdk/51 F03): `{base}/chat/completions`, with the
 * endpoint's model and dialect, under the transport rules of `ModelEndpoint`. Unlike the gateway's client it sends no
 * `X-Faden-*` header and none of the gateway's fields (`session_id`, `skills`, the person's name), and it reads nothing of
 * the gateway's from the answer: an endpoint cannot hand the agent a refusal, an approval, an event or a provenance
 * receipt. The system message comes from `ChatOptions.instructions`, which the agent's session sets above the chat stages.
 * Every answer ends with an `endpoint_marking` update (and `ChatResponse.endpointMarking`). .NET: `DirectChatClient`.
 */
export class DirectChatClient implements ChatStreamer {
  /** The endpoint this client talks to. */
  readonly endpoint: ModelEndpoint;
  /** The chat completions route. */
  readonly url: URL;
  readonly #transport: EndpointTransport;

  /** `transport` is for the endpoint check, which shares one transport between its steps. */
  constructor(endpoint: ModelEndpoint, transport?: EndpointTransport) {
    this.#transport = transport ?? new EndpointTransport(endpoint);
    this.endpoint = endpoint;
    this.url = endpointChatCompletions(this.#transport.base);
  }

  /** The whole answer at once. */
  async complete(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body = JSON.stringify(endpointRequest(messages, options, this.#model(options), false, this.#transport.dialect));
    const { response, text } = await this.#transport.request(this.url, () => build(body), options.signal);
    if (!response.ok) throw toEndpointError(response, text, this.endpoint.key !== undefined);
    const answer = toAnswer(text);
    answer.endpointMarking = endpointMarking(this.#transport.dialect, response, options);
    return answer;
  }

  /** The answer as it streams: text, reasoning, whole tool calls, usage, the finish, then the endpoint's marking. */
  async *stream(messages: readonly ChatMessage[], options: ChatOptions = {}): AsyncGenerator<ChatUpdate> {
    const body = JSON.stringify(endpointRequest(messages, options, this.#model(options), true, this.#transport.dialect));
    const response = await this.#transport.open(this.url, () => build(body), options.signal);
    if (!response.ok) throw toEndpointError(response, await textOf(response), this.endpoint.key !== undefined);
    const marking = endpointMarking(this.#transport.dialect, response, options);
    if (mediaType(response) === "application/json") {
      // A server that answers a streamed request with one whole answer (review R2): read it as one, never as nothing.
      yield* updatesOf(toAnswer(await textOf(response)));
      yield { type: "endpoint_marking", marking };
      return;
    }
    const assembler = new StreamAssembler(this.endpoint.logger, false);
    if (response.body) {
      // A read on a dead connection cannot be cancelled: the idle watchdog gives the stream up when it stays silent.
      for await (const sse of readSse(response.body, options.signal, this.#transport.streamIdleTimeoutMs, SSE_ENDPOINT_LIMITS)) {
        yield* assembler.read(sse);
        if (assembler.done) break;
      }
    }
    yield* assembler.flush();
    yield { type: "endpoint_marking", marking };
  }

  /** The request's model, else the endpoint's; the gateway's `"agent"` never goes to an endpoint. */
  #model(options: ChatOptions): string {
    const model = options.model || this.endpoint.model;
    if (!model) throw new TypeError("Set ModelEndpoint.model (or ChatOptions.model): the endpoint needs to know which model.");
    return model;
  }
}

function build(body: string): EndpointRequest {
  return { method: "POST", headers: { accept: "text/event-stream, application/json", "content-type": "application/json" }, body };
}

const mediaType = (response: Response): string => (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

/** A whole answer, read as an OpenAI chat completion; anything else is not compatible. */
function toAnswer(text: string): ChatResponse {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new EndpointNotCompatibleError(200, "The endpoint's answer is not an OpenAI chat completion (not JSON): check the base, which includes /v1.");
  }
  if (root === null || typeof root !== "object" || Array.isArray(root) || !("choices" in root)) {
    throw new EndpointNotCompatibleError(200, "The endpoint's answer is not an OpenAI chat completion (no choices): check the base, which includes /v1.");
  }
  return toResponse(root as Json, false);
}

/** The updates of a whole answer, in the order a stream brings them. */
function* updatesOf(answer: ChatResponse): Generator<ChatUpdate> {
  if (answer.usage) yield { type: "usage", usage: answer.usage };
  if (answer.reasoning) yield { type: "reasoning", text: answer.reasoning };
  if (answer.text) yield { type: "text", text: answer.text };
  if (answer.toolCalls.length) yield { type: "tool_calls", calls: answer.toolCalls };
  if (answer.finishReason) {
    const finish: ChatUpdate = { type: "finish", reason: answer.finishReason };
    if (answer.id) finish.responseId = answer.id;
    if (answer.model) finish.model = answer.model;
    yield finish;
  }
}

