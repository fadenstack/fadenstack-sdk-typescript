import { describe, expect, it } from "vitest";

import { FadenstackClient, FadenstackError, StaticTokenProvider, type ChatUpdate } from "@fadenstack/client";

// A streamed answer that goes silent is given up after the idle timeout; a keep-alive comment counts as life
// (sdk/51 I00 #6, I-8). The wait for the headers already has the request timeout (transport.ts, #withTimeout).

const encoder = new TextEncoder();

function chunk(content: string, finish?: string): string {
  return `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] })}\n\n`;
}

function client(body: ReadableStream<Uint8Array>, streamIdleTimeoutMs: number): FadenstackClient {
  return new FadenstackClient({
    serverUrl: "https://faden.test",
    agent: "docs-assistant",
    credentials: new StaticTokenProvider("agent-token"),
    fetch: () => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
    streamIdleTimeoutMs,
  });
}

async function text(updates: AsyncIterable<ChatUpdate>): Promise<string> {
  let out = "";
  for await (const update of updates) if (update.type === "text") out += update.text;
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a streamed answer's idle timeout", () => {
  it("gives up a stream that goes silent, and closes it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk("Hel"))); // then nothing, and never closed: a dead connection
      },
      cancel() {
        cancelled = true;
      },
    });
    const guard = AbortSignal.timeout(10_000); // the test's own limit, not the SDK's

    const reading = text(client(body, 300).chat.stream([{ role: "user", content: "hi" }], { signal: guard }));

    await expect(reading).rejects.toBeInstanceOf(FadenstackError);
    await expect(reading).rejects.toThrow(/sent nothing for/);
    expect(cancelled).toBe(true);
    expect(guard.aborted).toBe(false);
  });

  it("keeps a slow stream alive while keep-alive comments arrive", async () => {
    // 8 keep-alives 100 ms apart: longer than the idle timeout in all, never silent for that long.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 8; i++) {
          await sleep(100);
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }
        controller.enqueue(encoder.encode(chunk("Done.") + chunk("", "stop") + "data: [DONE]\n\n"));
        controller.close();
      },
    });

    expect(await text(client(body, 300).chat.stream([{ role: "user", content: "hi" }]))).toBe("Done.");
  });

  it("refuses a timeout that is not positive", () => {
    expect(() => client(new ReadableStream(), 0)).toThrow(TypeError);
  });
});
