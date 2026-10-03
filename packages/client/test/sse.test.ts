import { describe, expect, it } from "vitest";

import { readSse, type SseEvent } from "@fadenstack/client";

/** A body that arrives in the given pieces, as a network delivers it. */
function body(...pieces: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(typeof p === "string" ? encoder.encode(p) : p);
      controller.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of readSse(stream)) out.push(e);
  return out;
}

describe("readSse", () => {
  it("reads named events, data lines and the OpenAI chunks", async () => {
    const events = await all(body('event: faden\ndata: {"type":"CUSTOM"}\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'));
    expect(events).toEqual([
      { name: "faden", data: '{"type":"CUSTOM"}' },
      { name: undefined, data: '{"a":1}' },
      { name: undefined, data: "[DONE]" },
    ]);
  });

  it("joins multi-line data, skips comments, and takes any line ending", async () => {
    const events = await all(body(": keep-alive\r\ndata: one\r\ndata: two\r\n\r\ndata: three\r\rdata:four\n\n"));
    expect(events.map((e) => e.data)).toEqual(["one\ntwo", "three", "four"]);
  });

  it("puts lines and characters split across reads back together", async () => {
    const encoded = new TextEncoder().encode('data: {"t":"Grüße"}\n\n');
    const split = encoded.indexOf(0xc3) + 1; // inside the two bytes of ü
    const events = await all(body("da", "ta: x\n", "\n", encoded.slice(0, split), encoded.slice(split)));
    expect(events).toEqual([{ name: undefined, data: "x" }, { name: undefined, data: '{"t":"Grüße"}' }]);
  });

  it("keeps an event the server cut off without its blank line", async () => {
    expect(await all(body("data: last"))).toEqual([{ name: undefined, data: "last" }]);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const e of readSse(stream, controller.signal)) {
        seen.push(e.data);
        controller.abort(new Error("stopped"));
      }
    }).rejects.toThrow("stopped");
    expect(seen).toEqual(["first"]);
  });
});
