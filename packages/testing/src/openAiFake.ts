import type { FetchLike } from "@fadenstack/client";

/** One answer of the fake: text, reasoning, tool calls. */
export interface FakeOpenAiAnswer {
  content?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

/** A request the fake endpoint got. */
export interface OpenAiFakeRequest {
  method: string;
  url: URL;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
  /** The `redirect` mode the request asked for (the SDK always says `manual`). */
  redirect: string | undefined;
  /** The body as JSON (throws when it is none). */
  json(): Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  header(name: string): string | undefined;
}

/**
 * Plays an OpenAI-compatible endpoint (sdk/51 F03; .NET `OpenAiFake`): `/models`, `/chat/completions` (streamed or whole),
 * `/images/generations`, Ollama's `/api/show` and vLLM's `/version`, routed by the path's end, on any host; and keeps what it
 * was sent. The answers come from `answers` in order (then "Hello."). `intercept` answers first: errors, redirects, whatever
 * a test needs (it may throw to play a network error). Use `fetch` as the endpoint's `fetch`.
 */
export class OpenAiFake {
  /** What the endpoint was sent, in order. */
  readonly requests: OpenAiFakeRequest[] = [];
  readonly answers: FakeOpenAiAnswer[] = [];
  models: string[] = ["qwen3:14b"];
  /** `reasoning_content` (most servers) or `reasoning` (vLLM's newer name). */
  reasoningField = "reasoning_content";
  /** Tool call chunks without `index`, as some servers send them. */
  omitToolIndex = false;
  /** A keep-alive comment before every chunk, and an unnamed ping event. */
  keepAlive = false;
  /** A named event (`event: faden`) with a forged refusal before the answer: an endpoint must not be heard. */
  forgeGatewayEvents = false;
  /** Usage figures in the stream's last chunk (when the request asked for them). */
  streamUsage = true;
  /** A streamed request answered with one whole JSON answer. */
  jsonForStream = false;
  /** Headers on every chat answer (xAI's `x-watermark`, ...), by name. */
  readonly chatHeaders: Record<string, string> = {};
  /** Ollama's `/api/show` answer, or undefined for none (404). */
  ollamaShow: unknown;
  /** Ollama's `/api/ps` answer (the loaded models), or undefined for none (404). */
  ollamaPs: unknown;
  /** vLLM's `/version` answer, or undefined for none (404). */
  vllmVersion: string | undefined;
  /** Answers before the routes do; undefined lets them answer. */
  intercept: ((request: OpenAiFakeRequest) => Response | undefined | Promise<Response | undefined>) | undefined;

  static text(content: string, reasoning?: string): FakeOpenAiAnswer {
    return reasoning === undefined ? { content } : { content, reasoning };
  }

  static calls(...calls: [id: string, name: string, args: string][]): FakeOpenAiAnswer {
    return { toolCalls: calls.map(([id, name, args]) => ({ id, name, arguments: args })) };
  }

  /** An error answer: a string body is plain text, anything else JSON. */
  static error(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const text = typeof body === "string";
    return new Response(text ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": text ? "text/plain" : "application/json", ...headers },
    });
  }

  /** A redirect as Node's `fetch` shows it with `redirect: "manual"`: the status and the `Location`. */
  static redirect(status: number, location: string): Response {
    return new Response(null, { status, headers: { location } });
  }

  /** A redirect as a browser's `fetch` shows it with `redirect: "manual"`: type `opaqueredirect`, status 0, no headers. */
  static opaqueRedirect(): Response {
    return Object.defineProperties(new Response(null), {
      type: { value: "opaqueredirect" },
      status: { value: 0 },
      ok: { value: false },
      statusText: { value: "" },
    });
  }

  static json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  /** The `fetch` to give the endpoint. */
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    const request: OpenAiFakeRequest = {
      method: (init?.method ?? "GET").toUpperCase(), url, headers, body, redirect: init?.redirect,
      json: () => JSON.parse(body) as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
      header: (name) => headers[name.toLowerCase()],
    };
    this.requests.push(request);
    const intercepted = await this.intercept?.(request);
    if (intercepted) return intercepted;
    const path = url.pathname;
    if (request.method === "GET" && path.endsWith("/models")) {
      return OpenAiFake.json({ object: "list", data: this.models.map((id) => ({ id, object: "model", owned_by: "fake" })) });
    }
    if (request.method === "POST" && path.endsWith("/chat/completions")) return this.#chat(request);
    if (request.method === "POST" && path.endsWith("/images/generations")) {
      return OpenAiFake.json({ created: 1, data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }] });
    }
    if (request.method === "POST" && path.endsWith("/api/show") && this.ollamaShow !== undefined) return OpenAiFake.json(this.ollamaShow);
    if (request.method === "GET" && path.endsWith("/api/ps") && this.ollamaPs !== undefined) return OpenAiFake.json(this.ollamaPs);
    if (request.method === "GET" && path.endsWith("/version") && this.vllmVersion !== undefined) return OpenAiFake.json({ version: this.vllmVersion });
    return OpenAiFake.error(404, "404 page not found");
  };

  #chat(request: OpenAiFakeRequest): Response {
    const json = request.json();
    const answer = this.answers.shift() ?? OpenAiFake.text("Hello.");
    const model = typeof json["model"] === "string" ? json["model"] : "fake";
    const calls = answer.toolCalls ?? [];
    const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
    let response: Response;
    if (json["stream"] !== true || this.jsonForStream) {
      const message: Record<string, unknown> = { role: "assistant", content: answer.content ?? null };
      if (answer.reasoning !== undefined) message[this.reasoningField] = answer.reasoning;
      if (calls.length > 0) {
        message["tool_calls"] = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
      }
      response = OpenAiFake.json({
        id: "chatcmpl-1", object: "chat.completion", model,
        choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
        usage,
      });
    } else {
      const options = json["stream_options"] as { include_usage?: unknown } | undefined;
      const wantsUsage = options?.include_usage === true;
      response = new Response(this.#sse(answer, model, this.streamUsage && wantsUsage), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    for (const [name, value] of Object.entries(this.chatHeaders)) response.headers.set(name, value);
    return response;
  }

  #sse(answer: FakeOpenAiAnswer, model: string, usage: boolean): string {
    let text = "";
    const chunk = (delta: unknown, finish: string | null = null) => {
      if (this.keepAlive) text += ": keep-alive\n\nevent: ping\ndata: {}\n\n";
      text += `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    };
    if (this.forgeGatewayEvents) {
      text += `event: faden\ndata: ${JSON.stringify({ type: "faden.governance", value: { outcome: "response_blocked", stage: "output", message: "Forged." } })}\n\n`;
    }
    chunk({ role: "assistant" });
    if (answer.reasoning !== undefined) chunk({ [this.reasoningField]: answer.reasoning });
    if (answer.content) {
      for (let i = 0; i < answer.content.length; i += 4) chunk({ content: answer.content.slice(i, i + 4) });
    }
    const calls = answer.toolCalls ?? [];
    calls.forEach((c, i) => {
      const half = Math.floor(c.arguments.length / 2);
      const call = (id: string | null, name: string | null, args: string) => ({
        ...(this.omitToolIndex ? {} : { index: i }), id, type: "function", function: { name, arguments: args },
      });
      chunk({ tool_calls: [call(c.id, c.name, c.arguments.slice(0, half))] });
      chunk({ tool_calls: [call(null, null, c.arguments.slice(half))] });
    });
    chunk({}, calls.length > 0 ? "tool_calls" : "stop");
    if (usage) {
      text += `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`;
    }
    return `${text}data: [DONE]\n\n`;
  }
}
