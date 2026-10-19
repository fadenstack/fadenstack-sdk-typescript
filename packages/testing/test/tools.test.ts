import { describe, expect, it } from "vitest";

import { defineTool, toolServiceKey } from "@fadenstack/agents";
import { provenanceOf } from "@fadenstack/provenance";
import { toolContext, toolServices } from "@fadenstack/testing";
import { PassThroughProvenance, provenanceServices } from "@fadenstack/testing/provenance";

/** A tool as an integrator writes it: it places its text through the provenance module. */
const insertReply = defineTool<{ text: string }>({
  name: "insert_reply",
  toolClass: "write",
  output: { argument: "text", mediaType: "text/html", edit: "generated" },
  run: async ({ text }, context) => {
    const editor: string[] = [];
    const placement = await provenanceOf(context).place(
      { content: text, mediaType: "text/html", sink: { kind: "html.editor", container: true, carries: ["html-attribute"] } },
      (marked) => {
        editor.push(String(marked.content));
        return editor.length;
      },
    );
    return `${editor.join("")} (${placement.result}, ${placement.recordId ?? "no record"})`;
  },
});

describe("running a tool by hand", () => {
  it("gives a hand-built call a pass-through provenance: the content goes in as it is, the requests are kept", async () => {
    const provenance = new PassThroughProvenance();
    const result = await insertReply.invoke({ text: "<p>Hello</p>" }, toolContext({ services: provenanceServices(provenance) }));
    expect(result).toBe("<p>Hello</p> (1, no record)");
    expect(provenance.requests).toEqual([{ content: "<p>Hello</p>", mediaType: "text/html", sink: expect.objectContaining({ kind: "html.editor" }) }]);
    expect((await provenance.policy()).short_text_tokens).toBe(200);
    expect(new PassThroughProvenance({ policy: { on_missing: "refuse" } }).policy()).resolves.toMatchObject({ on_missing: "refuse" });
  });

  it("has no services unless given, and the given ones by key", async () => {
    await expect(insertReply.invoke({ text: "x" }, toolContext())).rejects.toThrow(/provenance module is not added/);
    const Counter = toolServiceKey<{ n: number }>("counter");
    const counter = { n: 1 };
    const context = toolContext({ services: toolServices([Counter, counter]), callId: "c-7" });
    expect([context.services.get(Counter), context.services.get(toolServiceKey("counter")), context.callId]).toEqual([counter, undefined, "c-7"]);
    expect(context.signal.aborted).toBe(false);
  });
});
