import { FadenstackError, FadenstackStreamError } from "../errors.js";

/** One server-sent event: its name (`event:`, undefined for the OpenAI chunks) and its data. */
export interface SseEvent {
  name: string | undefined;
  data: string;
}

/**
 * How much one stream may send (N9): a faulty or hostile server, or a proxy, must not make the client hold unbounded text.
 * Past a limit the stream ends with a `FadenstackStreamError` (code `stream_too_large`). Sizes are in characters.
 * .NET: `SseLimits`.
 */
export interface SseLimits {
  /** The longest line. */
  maxLineChars: number;
  /** The most one event's data may hold. */
  maxEventChars: number;
  /** The most the whole stream may send; undefined: no limit (the gateway's own stream). */
  maxTotalChars?: number;
}

/** The gateway's limits: lines and events only. */
export const SSE_GATEWAY_LIMITS: Readonly<SseLimits> = Object.freeze({ maxLineChars: 4 * 1024 * 1024, maxEventChars: 8 * 1024 * 1024 });

/** A person's own endpoint, which may be anything: the whole answer is limited too. */
export const SSE_ENDPOINT_LIMITS: Readonly<SseLimits> = Object.freeze({ ...SSE_GATEWAY_LIMITS, maxTotalChars: 64 * 1024 * 1024 });

/** The error for a stream past a limit: `what` is "a line", "an event", "the whole answer", "a tool call's arguments". */
export function streamTooLarge(what: string): FadenstackStreamError {
  return new FadenstackStreamError(`The answer broke off: ${what} was larger than the SDK accepts.`, "stream_too_large");
}

/**
 * Reads `text/event-stream` event by event (the WHATWG rules: `event:` and `data:` fields, multi-line data,
 * comments, any line ending). Reading stops when the caller stops iterating. With `idleMs`, a stream that sends nothing
 * at all for that long is given up: it is cancelled and a `FadenstackError` says so (any byte counts, a keep-alive too).
 * `limits` bound the stream (the gateway's by default): past one it ends with a `FadenstackStreamError` (`stream_too_large`).
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleMs?: number,
  limits: SseLimits = SSE_GATEWAY_LIMITS,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let name: string | undefined;
  let data: string[] = [];
  let dataChars = 0;
  let total = 0;
  let scanFrom = 0;
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await within(reader.read(), idleMs, reader);
      if (signal?.aborted) throw signal.reason;
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      total += chunk.length;
      if (limits.maxTotalChars !== undefined && total > limits.maxTotalChars) throw streamTooLarge("the whole answer");
      buffer += chunk;
      let start = 0;
      for (;;) {
        const end = nextLineEnd(buffer, Math.max(start, scanFrom));
        if (end < 0) break;
        if (end - start > limits.maxLineChars) throw streamTooLarge("a line");
        const line = buffer.slice(start, end);
        start = end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1);
        if (line === "") {
          if (data.length > 0) yield { name, data: data.join("\n") };
          name = undefined;
          data = [];
          dataChars = 0;
          continue;
        }
        if (line.startsWith(":")) continue; // a comment, e.g. a keep-alive
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") {
          if (dataChars + value.length + 1 > limits.maxEventChars) throw streamTooLarge("an event");
          dataChars += value.length + 1;
          data.push(value);
        }
      }
      if (buffer.length - start > limits.maxLineChars) throw streamTooLarge("a line"); // a line still without its end
      buffer = buffer.slice(start);
      // Nothing before here holds a line end, so the next read looks only at what is new (a lone CR at the end waits).
      scanFrom = buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
      if (done) {
        if (buffer !== "" && buffer.startsWith("data")) {
          const colon = buffer.indexOf(":");
          data.push(colon < 0 ? "" : buffer.slice(colon + 1).replace(/^ /, ""));
        }
        if (data.length > 0) yield { name, data: data.join("\n") };
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Closes the connection when the caller stopped early; a no-op after the end.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * A read that is given up when nothing arrives for `idleMs`: a dead connection (a laptop that slept, a dropped network)
 * would otherwise keep the answer "thinking" for ever. The reader is cancelled, which closes the connection.
 */
function within(
  read: Promise<ReadableStreamReadResult<Uint8Array>>,
  idleMs: number | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleMs === undefined || !Number.isFinite(idleMs)) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejected before the cancel: the cancel ends the pending read as "done", which must not pass for the answer's end.
      reject(new FadenstackError(`The server sent nothing for ${Math.round(idleMs / 1000)} s; the answer was given up.`));
      void reader.cancel().catch(() => undefined);
    }, idleMs);
  });
  return Promise.race([read, idle]).finally(() => clearTimeout(timer));
}

/** The index of the next line end (`\n`, `\r\n` or `\r`), or -1. A lone `\r` at the very end waits for more. */
function nextLineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return i;
    if (c === "\r") return i + 1 < text.length ? i : -1;
  }
  return -1;
}
