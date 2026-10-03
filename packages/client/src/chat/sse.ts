/** One server-sent event: its name (`event:`, undefined for the OpenAI chunks) and its data. */
export interface SseEvent {
  name: string | undefined;
  data: string;
}

/**
 * Reads `text/event-stream` event by event (the WHATWG rules: `event:` and `data:` fields, multi-line data,
 * comments, any line ending). Reading stops when the caller stops iterating.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let name: string | undefined;
  let data: string[] = [];
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const end = nextLineEnd(buffer, start);
        if (end < 0) break;
        const line = buffer.slice(start, end);
        start = end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1);
        if (line === "") {
          if (data.length > 0) yield { name, data: data.join("\n") };
          name = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue; // a comment, e.g. a keep-alive
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      buffer = buffer.slice(start);
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

/** The index of the next line end (`\n`, `\r\n` or `\r`), or -1. A lone `\r` at the very end waits for more. */
function nextLineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return i;
    if (c === "\r") return i + 1 < text.length ? i : -1;
  }
  return -1;
}
