import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpAgent, type Message } from "@ag-ui/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The golden streams (byte-identical to the .NET SDK's) read by an off-the-shelf AG-UI client: @ag-ui/client's HttpAgent
// verifies the event order and the schemas of every event it receives. The server is on 127.0.0.1 only.

const dir = join(dirname(fileURLToPath(import.meta.url)), "agui");

function events(name: string): string[] {
  return readFileSync(join(dir, `${name}.jsonl`), "utf8").split("\n").filter((line) => line.length > 0);
}

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = (req.url ?? "").replace(/^\//, "");
    if (req.method !== "POST" || !/^[a-z]+$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const line of events(name)) res.write(`data: ${line}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function agent(name: string): HttpAgent {
  return new HttpAgent({ url: `${base}/${name}`, threadId: "thread-1" });
}

const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : "");

describe("the golden AG-UI streams in @ag-ui/client", () => {
  it("text: the assistant text and the reasoning arrive", async () => {
    const a = agent("text");
    const result = await a.runAgent({ runId: "turn-1" });
    const assistant = result.newMessages.find((m) => m.role === "assistant");
    expect(assistant && textOf(assistant)).toBe("Hello <b>world</b> & \"all\" - caf\u00e9\nBye");
    const reasoning = result.newMessages.find((m) => m.role === "reasoning");
    expect(reasoning && textOf(reasoning)).toBe("Greeting the user.");
  });

  it("tool: the call with its arguments and its result", async () => {
    const a = agent("tool");
    const result = await a.runAgent({ runId: "turn-1" });
    const call = result.newMessages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .find((c) => c.id === "call-1");
    expect(call?.function.name).toBe("read_page");
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ page: 7, note: "a<b" });
    const toolResult = result.newMessages.find((m) => m.role === "tool");
    expect(toolResult && textOf(toolResult)).toBe("Table T1, 4 rows");
    expect(toolResult && "toolCallId" in toolResult && toolResult.toolCallId).toBe("call-1");
    const texts = result.newMessages.filter((m) => m.role === "assistant").map(textOf);
    expect(texts).toContain("Let me look.");
    expect(texts).toContain("Four rows.");
  });

  it("approval: the interrupt and the resumed run are accepted, the result arrives", async () => {
    const a = agent("approval");
    const result = await a.runAgent({ runId: "turn-1" });
    const call = result.newMessages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .find((c) => c.id === "call-2");
    expect(call?.function.name).toBe("delete_page");
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ page: 8 });
    const toolResult = result.newMessages.find((m) => m.role === "tool");
    expect(toolResult && textOf(toolResult)).toBe("deleted");
    expect(result.newMessages.filter((m) => m.role === "assistant").map(textOf)).toContain("Deleted.");
  });

  it("notice: the faden.* custom events and the blocked run are accepted", async () => {
    const custom: string[] = [];
    const a = agent("notice");
    await a.runAgent(
      { runId: "turn-1" },
      { onCustomEvent: ({ event }) => void custom.push(event.name) },
    );
    expect(custom).toEqual(["faden.citations", "faden.notice"]);
  });

  it("error: the partial text arrives and RUN_ERROR reaches the client as an error event", async () => {
    // @ag-ui/client 1.0.4 does not reject runAgent for a RUN_ERROR the server sent: it hands the event to the subscriber's
    // onRunErrorEvent and ends the run, keeping the messages so far.
    const a = agent("error");
    const errors: string[] = [];
    const result = await a.runAgent({ runId: "turn-1" }, { onRunErrorEvent: ({ event }) => void errors.push(event.message) });
    expect(errors).toEqual(["The model call failed."]);
    expect(result.newMessages.filter((m) => m.role === "assistant").map(textOf)).toEqual(["Partial"]);
  });
});
