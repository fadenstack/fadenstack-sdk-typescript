import { describe, expect, it, vi } from "vitest";

import { textSha256 } from "@fadenstack/client";
import { defineTool, type AgentTool } from "@fadenstack/agents";
import {
  ProvenanceEntryTypes,
  ProvenanceReader,
  provenanceOf,
  similarityClassifier,
  type ObservedPlacement,
  type PlaceRequest,
  type Placement,
  type SinkInfo,
} from "@fadenstack/provenance";

import { contractSchema, validate } from "../../client/test/jsonSchema.js";
import { Editor, LONG, run } from "./helpers.js";

/** A tool that fills a web editor through `place()`, as the Chrome agent's fill_field does. */
function fillField(editor: Editor, request: Partial<PlaceRequest> = {}, seen: Placement<string>[] = []): AgentTool {
  return defineTool<{ text: string }>({
    name: "fill_field",
    toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { argument: "text", mediaType: "text/html", edit: "generated" },
    run: async ({ text }, context) => {
      const placement = await provenanceOf(context).place(
        { content: text, mediaType: "text/html", sink: editor.sink, ...request },
        (marked) => editor.insert(String(marked.content)),
      );
      seen.push(placement);
      return `Inserted (${placement.recordId}).`;
    },
  });
}

const placementSchema = contractSchema("placement-report");
const recordRequestSchema = (() => {
  const schema = contractSchema("record-request");
  delete schema.properties!["agent"];
  return schema;
})();

describe("placing content", () => {
  it("signs a record by the hash, marks the editor's HTML, reads it back, records and reports the placement", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: `<p>${LONG}</p>` } });
    await r.session.send("Write the reply.");
    const placement = seen[0]!;
    const signed = r.gateway.provenanceRecords[0]!;
    expect(placement).toMatchObject({ recordId: signed.signed.record.id, signed: true, exempt: false, editKind: "generated" });
    // The server got the content's hash, never the content.
    expect(signed.request).toEqual({
      content_sha256: await textSha256(`<p>${LONG}</p>`), media_type: "text/html", edit_kind: "generated",
      receipt_id: r.gateway.receipts[0]!.id, model: "fake-model",
    });
    expect(validate(recordRequestSchema, signed.request)).toEqual([]);
    expect(JSON.stringify(r.gateway.requests.filter((q) => q.path.includes("/provenance/")).map((q) => q.body))).not.toContain("delivery");
    // The editor holds the content in a marked element; the mark held.
    expect(new ProvenanceReader().fromHtml(editor.html)).toEqual([
      { carrier: "html-attribute", recordId: placement.recordId }, { carrier: "html-title", recordId: placement.recordId },
    ]);
    expect(editor.html).toContain(`title="AI-generated (record ${placement.recordId})"`);
    expect(placement.layers).toEqual([
      { layer: "metadata", method: "signed-record", applied: true },
      { layer: "metadata", method: "html-attribute+title", applied: true },
      { layer: "watermark", method: "none", applied: false, reason: "runtime-without-watermark" },
    ]);
    expect(placement.missing).toEqual([{ layer: "watermark", reason: "runtime-without-watermark" }]);
    // Reported, in the contract's shape, and in the transcript under the turn.
    const report = r.gateway.placements[0]!.report;
    expect(validate(placementSchema, report)).toEqual([]);
    expect(report).toEqual({
      record_id: placement.recordId, tool: "fill_field", sink_kind: "html.editor", media_type: "text/html", edit_kind: "generated",
      length_class: "medium", layers: placement.layers,
    });
    const entry = r.entries(ProvenanceEntryTypes.placed)[0]!;
    expect(entry.data).toMatchObject({ tool: "fill_field", record_id: placement.recordId, signed: true, exempt: false, reported: true });
    expect(JSON.stringify(entry.data)).not.toContain("delivery");
    expect(r.toolResult()).toBe(`Inserted (${placement.recordId}).`);
  });

  it("records what a host keeps: Gmail drops data- attributes and keeps the title", async () => {
    const editor = new Editor(true);
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } });
    await r.session.send("Write the reply.");
    expect(editor.html).not.toContain("data-ai-generated");
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "html-title", applied: true });
    expect(seen[0]!.missing).toEqual([{ layer: "watermark", reason: "runtime-without-watermark" }]);
  });

  it("writes the title in the user's language, from the UI catalogues", async () => {
    const { germanStrings } = await import("@fadenstack/ui");
    const editor = new Editor();
    const r = await run([fillField(editor)], { tool: "fill_field", args: { text: LONG } }, { module: { strings: germanStrings } });
    await r.session.send("Antwort schreiben.");
    const id = r.gateway.provenanceRecords[0]!.signed.record.id;
    expect(editor.html).toContain(`title="KI-generiert (Datensatz ${id})"`);
    expect(new ProvenanceReader().fromHtml(editor.html).map((m) => m.carrier)).toEqual(["html-attribute", "html-title"]);
  });

  it("records the watermark the receipt names", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } },
      { gateway: { provenance: { receipts: true, watermark: { applied: "model", algorithm: "vllm-gumbel" } } } });
    await r.session.send("Write the reply.");
    expect(seen[0]!.layers).toContainEqual({ layer: "watermark", method: "vllm-gumbel", applied: true });
    expect(seen[0]!.missing).toEqual([]);
  });
});

describe("exempt content", () => {
  it.each([
    ["a translation", { editKind: "translated" as const }, LONG, "text/html", "exempt-edit"],
    ["short text", {}, "Thanks, see you on Friday.", "text/html", "short-text"],
    ["code", {}, `{"total": 42, "items": ["${LONG}"]}`, "application/json", "exempt-edit"],
  ])("is placed as it is and recorded as exempt: %s", async (_, request, text, mediaType, reason) => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, { ...request, mediaType }, seen)], { tool: "fill_field", args: { text } });
    await r.session.send("Go");
    expect(editor.html).toBe(text);
    expect(r.gateway.provenanceRecords).toEqual([]);
    expect(seen[0]).toMatchObject({ exempt: true, signed: false, reason, missing: [] });
    const report = r.gateway.placements[0]!.report;
    expect(report.record_id).toMatch(/^exempt-[0-9a-f]{32}$/);
    expect(report.layers.every((l) => !l.applied && l.reason === reason)).toBe(true);
    expect(validate(placementSchema, report)).toEqual([]);
  });

  it("follows the agent's policy: a lower threshold marks shorter text", async () => {
    const editor = new Editor();
    const r = await run([fillField(editor)], { tool: "fill_field", args: { text: "Thanks, see you on Friday." } },
      { agent: { provenancePolicy: { short_text_tokens: 2 } } });
    await r.session.send("Go");
    expect(r.gateway.provenanceRecords).toHaveLength(1);
    expect(editor.html).toContain("data-ai-generated");
  });
});

describe("the policy", () => {
  const nowhere: SinkInfo = { kind: "crm.note", container: true, carries: [] };

  it("records a layer that is not possible, by default, and places the content", async () => {
    let inserted = "";
    const tool = defineTool<{ text: string }>({
      name: "add_note", toolClass: "write", output: { argument: "text", mediaType: "text/plain", edit: "generated" },
      run: async ({ text }, context) => (await provenanceOf(context).place({ content: text, mediaType: "text/plain", sink: nowhere }, (m) => {
        inserted = String(m.content);
      })).missing,
    });
    const r = await run([tool], { tool: "add_note", args: { text: LONG } });
    await r.session.send("Note it.");
    expect(inserted).toBe(LONG);
    expect(r.gateway.placements[0]!.report.layers).toContainEqual({ layer: "metadata", method: "none", applied: false, reason: "sink-cannot-carry" });
  });

  it("refuses with `refuse`, telling the model why, and places nothing", async () => {
    let inserted = false;
    const tool = defineTool<{ text: string }>({
      name: "add_note", toolClass: "write", output: { argument: "text", mediaType: "text/plain", edit: "generated" },
      run: async ({ text }, context) => provenanceOf(context).place({ content: text, mediaType: "text/plain", sink: nowhere }, () => {
        inserted = true;
      }),
    });
    const r = await run([tool], { tool: "add_note", args: { text: LONG } }, { agent: { provenancePolicy: { on_missing: "refuse" } } });
    await r.session.send("Note it.");
    expect(inserted).toBe(false);
    expect(r.toolResult()).toMatch(/^Error: Not placed: .*metadata layer \(this place cannot carry a mark\).*watermark layer/);
    expect(r.entries(ProvenanceEntryTypes.refused)[0]!.data).toMatchObject({
      tool: "add_note", missing: [{ layer: "metadata", reason: "sink-cannot-carry" }, { layer: "watermark", reason: "runtime-without-watermark" }],
    });
    expect(r.gateway.provenanceRecords).toEqual([]); // refused before anything was signed
    expect(r.gateway.placements).toEqual([]);
  });

  it("refuses with `refuse` when the server cannot sign, and records it without by default", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const watermarked = { receipts: true, watermark: { applied: "model" as const, algorithm: "vllm-gumbel" } };
    const recorded = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } }, { gateway: { provenance: watermarked } });
    recorded.gateway.setProvenanceDown(true);
    await recorded.session.send("Write it.");
    const id = seen[0]!.recordId;
    expect(id).toMatch(/^unsigned-[0-9a-f]{32}$/);
    expect(editor.html).toContain(`data-ai-generated="${id}"`); // still marked as made with AI
    expect(seen[0]!.missing).toEqual([{ layer: "metadata", reason: "server-unavailable" }, { layer: "watermark", reason: "server-unavailable" }]);
    const refused = await run([fillField(new Editor())], { tool: "fill_field", args: { text: LONG } },
      { agent: { provenancePolicy: { on_missing: "refuse" } }, gateway: { provenance: watermarked } });
    await refused.session.send("While the server is up: the policy is known."); // placed
    refused.gateway.setProvenanceDown(true);
    await refused.session.send("Write it.");
    expect(refused.toolResult()).toContain("the server could not sign the record");
  });

  it("can be tightened locally, never loosened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tool = defineTool<{ text: string }>({
      name: "add_note", toolClass: "write",
      run: async ({ text }, context) => JSON.stringify(await provenanceOf(context).policy()) + text,
    });
    const r = await run([tool], { tool: "add_note", args: { text: "" } }, {
      agent: { provenancePolicy: { short_text_tokens: 100 } },
      module: { policy: { on_missing: "refuse", short_text_tokens: 500, exempt_edit_kinds: ["translated", "summarised"] } },
    });
    await r.session.send("Go");
    expect(JSON.parse(r.toolResult())).toMatchObject({ on_missing: "refuse", short_text_tokens: 100, exempt_edit_kinds: ["translated"] });
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/short_text_tokens 500.*\n.*summarised/s);
    warn.mockRestore();
  });
});

describe("the check after a tool", () => {
  const sloppy = defineTool<{ text: string }>({
    name: "insert_text", toolClass: "write", output: { argument: "text", mediaType: "text/markdown", edit: "generated" },
    run: () => "inserted, without place()",
  });

  it("records declared content that did not go through place(), and reports it without a record", async () => {
    const r = await run([sloppy], { tool: "insert_text", args: { text: LONG } });
    await r.session.send("Go");
    expect(r.toolResult()).toBe("inserted, without place()");
    expect(r.entries(ProvenanceEntryTypes.unmarked)[0]!.data).toMatchObject({ tool: "insert_text", argument: "text", edit_kind: "generated" });
    const report = r.gateway.placements[0]!.report;
    expect(report).toMatchObject({ sink_kind: "unmarked", layers: [] });
    expect(report.record_id).toMatch(/^unmarked-/);
  });

  it("fails the call in development", async () => {
    const r = await run([sloppy], { tool: "insert_text", args: { text: LONG } }, { module: { development: true } });
    await r.session.send("Go");
    expect(r.toolResult()).toMatch(/^Error: 'insert_text' declares content for people in 'text' and did not place it through place\(\)/);
  });

  it("leaves exempt kinds and tools without content alone", async () => {
    const translate = defineTool<{ text: string }>({
      name: "translate", toolClass: "write", output: { argument: "text", mediaType: "text/plain", edit: "translated" }, run: () => "ok",
    });
    const r = await run([translate], { tool: "translate", args: { text: LONG } }, { module: { development: true } });
    await r.session.send("Go");
    expect(r.toolResult()).toBe("ok");
    expect(r.entries(ProvenanceEntryTypes.unmarked)).toEqual([]);
  });
});

describe("extension points", () => {
  it("lets a classifier lower the kind with a reason, which is recorded on the device only", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const original = LONG;
    const polished = LONG.replace("arrives on Friday", "arrives on Friday morning");
    const tool = defineTool<{ text: string }>({
      name: "improve", toolClass: "write", output: { argument: "text", mediaType: "text/html", edit: "rewritten" },
      run: async ({ text }, context) => {
        seen.push(await provenanceOf(context).place({ content: text, mediaType: "text/html", sink: editor.sink, original }, (m) => editor.insert(String(m.content))));
        return "ok";
      },
    });
    const r = await run([tool], { tool: "improve", args: { text: polished } }, { module: { classifier: similarityClassifier() } });
    await r.session.send("Improve it.");
    expect(seen[0]).toMatchObject({ editKind: "corrected", exempt: true, reason: "exempt-edit" });
    const entry = r.entries(ProvenanceEntryTypes.placed)[0]!.data;
    expect(entry).toMatchObject({ edit_kind: "corrected", declared_edit_kind: "rewritten", edit_reason: expect.stringMatching(/^a small change/) });
    expect(JSON.stringify(r.gateway.placements)).not.toContain("small change");
  });

  it("ignores a classifier that lowers the kind to an exempt one without a reason", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } },
      { module: { classifier: { classify: () => ({ kind: "corrected" }) } } });
    await r.session.send("Go");
    expect(seen[0]).toMatchObject({ editKind: "generated", exempt: false });
  });

  it("adds an enricher's facts under its namespace and drops what looks personal", async () => {
    const files = new Map<string, string>();
    const tool = defineTool<{ text: string }>({
      name: "save_file", toolClass: "write", output: { argument: "text", mediaType: "text/markdown", edit: "summarised" },
      run: async ({ text }, context) => {
        const sidecar = { fileName: "Summary.md", write: (n: string, t: string) => void files.set(n, t), read: (n: string) => files.get(n) };
        const sink: SinkInfo = { kind: "file", carries: ["sidecar"], sidecar };
        await provenanceOf(context).place({ content: text, mediaType: "text/markdown", sink }, (m) => void files.set("Summary.md", String(m.content)));
        return "saved";
      },
    });
    const r = await run([tool], { tool: "save_file", args: { text: LONG } }, {
      module: {
        enrichers: [
          { namespace: "com.example", enrich: () => ({ matter: "M-2026-118", owner: "erika@example.com", urgent: true }) },
          { namespace: "c2pa", enrich: () => ({ actions: "none" }) },
        ],
      },
    });
    await r.session.send("Summarise it.");
    const sidecar = JSON.parse(files.get("Summary.md.provenance.json")!) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ ai_generated: true, edit_kind: "summarised", extensions: { "com.example.matter": "M-2026-118", "com.example.urgent": true } });
    expect(JSON.stringify(sidecar)).not.toContain("erika");
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data["dropped_extensions"]).toEqual(["com.example.owner", "c2pa.*"]);
    expect(new ProvenanceReader().fromSidecar(files.get("Summary.md.provenance.json")!)[0]!.recordId).toBe(r.gateway.provenanceRecords[0]!.signed.record.id);
  });

  it("tells observers about every placement, and a failing observer changes nothing", async () => {
    const observed: ObservedPlacement[] = [];
    const editor = new Editor();
    const r = await run([fillField(editor)], { tool: "fill_field", args: { text: LONG } }, {
      module: { observers: [{ observe: (p) => void observed.push(p) }, { observe: () => { throw new Error("broken"); } }] },
    });
    await r.session.send("Go");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.report).toEqual(r.gateway.placements[0]!.report);
    expect(Object.isFrozen(observed[0]!.report)).toBe(true);
    expect(r.toolResult()).toMatch(/^Inserted/);
  });

  it("satisfies an agent that requires the module", async () => {
    const r = await run([fillField(new Editor())], { tool: "fill_field", args: { text: LONG } }, { agent: { requiredClientModules: ["provenance"] } });
    await expect(r.session.send("Go")).resolves.toMatchObject({ outcome: "completed" });
    await expect(run([], { tool: "x", args: {} }, { agent: { requiredClientModules: ["provenance"] }, withoutModule: true }))
      .rejects.toThrow(/needs the module\(s\) provenance/);
  });
});
