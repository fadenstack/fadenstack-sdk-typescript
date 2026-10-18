import { describe, expect, it, vi } from "vitest";

import { textSha256 } from "@fadenstack/client";
import { defineTool, type AgentTool } from "@fadenstack/agents";
import {
  MemoryBackend,
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

const watermarked = { receipts: true, watermark: { applied: "model" as const, algorithm: "gumbel" } };

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
    const id = placement.recordId!;
    expect(new ProvenanceReader().fromHtml(editor.html)).toEqual([
      { carrier: "html-attribute", recordId: id }, { carrier: "html-title", recordId: id },
    ]);
    expect(editor.html.startsWith(`<div data-ai-generated="${id}" title="AI-generated ${id}"><p>The delivery`)).toBe(true);
    expect(placement.layers).toEqual([
      { layer: "metadata", method: "signed-record", applied: true },
      { layer: "metadata", method: "html-attribute", applied: true, verified: true },
      { layer: "watermark", method: "model", applied: false, reason: "runtime-without-watermark" },
    ]);
    expect(placement.missing).toEqual([{ layer: "watermark", method: "model", reason: "runtime-without-watermark" }]);
    // Reported, in the contract's shape, and in the transcript under the turn.
    const report = r.gateway.placements[0]!.report;
    expect(validate(placementSchema, report)).toEqual([]);
    expect(report).toEqual({
      record_id: id, tool: "fill_field", sink_kind: "html.editor", media_type: "text/html", edit_kind: "generated",
      length_class: "medium", layers: placement.layers,
    });
    const entry = r.entries(ProvenanceEntryTypes.placed)[0]!;
    expect(entry.data).toMatchObject({
      tool: "fill_field", argument: "text", record_id: id, signed: true, exempt: false, exempt_because: null, reported: true,
      receipt_id: r.gateway.receipts[0]!.id, length_class: "medium",
    });
    expect((entry.data["layers"] as Record<string, unknown>[])[1]).toEqual({
      layer: "metadata", method: "html-attribute", applied: true, reason: null, verified: true, detail: "data-ai-generated, title",
    });
    expect(JSON.stringify(entry.data)).not.toContain("delivery");
    expect(r.toolResult()).toBe(`Inserted (${id}).`);
  });

  it("records what a host keeps: Gmail drops data- attributes and keeps the title", async () => {
    const editor = new Editor(true);
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } });
    await r.session.send("Write the reply.");
    expect(editor.html).not.toContain("data-ai-generated");
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "html-title", applied: true, verified: true });
    expect(seen[0]!.missing).toEqual([{ layer: "watermark", method: "model", reason: "runtime-without-watermark" }]);
  });

  it("writes the title in the user's language, from the UI catalogues", async () => {
    const { germanStrings } = await import("@fadenstack/ui");
    const editor = new Editor();
    const r = await run([fillField(editor)], { tool: "fill_field", args: { text: LONG } }, { module: { strings: germanStrings } });
    await r.session.send("Antwort schreiben.");
    const id = r.gateway.provenanceRecords[0]!.signed.record.id;
    expect(editor.html).toContain(`title="KI-generiert ${id}"`);
    expect(new ProvenanceReader().fromHtml(editor.html).map((m) => m.carrier)).toEqual(["html-attribute", "html-title"]);
  });

  it("records the watermark the receipt names", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } }, { gateway: { provenance: watermarked } });
    await r.session.send("Write the reply.");
    expect(seen[0]!.layers).toContainEqual({ layer: "watermark", method: "vllm-gumbel", applied: true });
    expect(seen[0]!.missing).toEqual([]);
  });

  it("gives a tool call the receipt of the answer it came from, never an earlier one", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    let calls = 0;
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } }, {
      gateway: {
        provenance: watermarked,
        model: () => (++calls === 1 ? { text: "First.", toolCalls: [{ name: "fill_field", arguments: { text: LONG } }] }
          : calls === 2 ? { text: "", toolCalls: [{ name: "fill_field", arguments: { text: `${LONG} Again.` } }], receipt: false }
          : { text: "Done." }),
      },
    });
    await r.session.send("Write it twice.");
    const receipts = r.gateway.provenanceRecords.map((s) => s.request["receipt_id"]);
    expect(receipts).toEqual([r.gateway.receipts[0]!.id, undefined]);
    expect(seen[1]!.layers).toContainEqual({ layer: "watermark", method: "model", applied: false });
  });
});

describe("exempt content", () => {
  it.each([
    ["a translation", { editKind: "translated" as const }, LONG, "text/html", "edit-kind"],
    ["code", {}, `{"total": 42, "items": ["${LONG}"]}`, "application/json", "code"],
    ["a label", {}, "Approved", "text/html", "label"],
  ])("is placed as it is, with no record, and recorded as exempt: %s", async (_, request, text, mediaType, because) => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, { ...request, mediaType }, seen)], { tool: "fill_field", args: { text } });
    await r.session.send("Go");
    expect(editor.html).toBe(text);
    expect(r.gateway.provenanceRecords).toEqual([]);
    expect(seen[0]).toMatchObject({ exempt: true, signed: false, recordId: undefined, reason: "exempt-edit", exemptBecause: because, missing: [] });
    const report = r.gateway.placements[0]!.report;
    expect("record_id" in report).toBe(false);
    expect(report.layers).toEqual([{ layer: "metadata", method: "record", applied: false, reason: "exempt-edit" }]);
    expect(validate(placementSchema, report)).toEqual([]);
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data).toMatchObject({ exempt: true, exempt_because: because, record_id: null });
  });

  it("short text is not exempt: it gets a record and its marks, and only the watermark is not expected", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: "Thanks, see you on Friday." } });
    await r.session.send("Go");
    expect(r.gateway.provenanceRecords).toHaveLength(1);
    expect(editor.html).toContain("data-ai-generated");
    expect(seen[0]).toMatchObject({ exempt: false, signed: true, missing: [] });
    expect(seen[0]!.layers).toContainEqual({ layer: "watermark", method: "model", applied: false, reason: "short-text" });
    expect(r.gateway.placements[0]!.report.length_class).toBe("short");
  });

  it("follows the agent's policy: a lower threshold expects the watermark sooner", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: "Thanks, see you on Friday." } },
      { agent: { provenancePolicy: { short_text_tokens: 2 } } });
    await r.session.send("Go");
    expect(seen[0]!.missing).toEqual([{ layer: "watermark", method: "model", reason: "runtime-without-watermark" }]);
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
    expect(r.gateway.placements[0]!.report.layers).toContainEqual({ layer: "metadata", method: "host", applied: false, reason: "sink-cannot-carry" });
  });

  it("refuses with `refuse`, telling the model and the user why, and places, signs and reports nothing", async () => {
    let inserted = false;
    const tool = defineTool<{ text: string }>({
      name: "add_note", toolClass: "write", output: { argument: "text", mediaType: "text/plain", edit: "generated" },
      run: async ({ text }, context) => provenanceOf(context).place({ content: text, mediaType: "text/plain", sink: nowhere }, () => {
        inserted = true;
      }),
    });
    const r = await run([tool], { tool: "add_note", args: { text: LONG } }, { agent: { provenancePolicy: { on_missing: "refuse" } } });
    const result = await r.session.send("Note it.");
    expect(inserted).toBe(false);
    expect(r.toolResult()).toBe("Error: Not written: this agent only places content it can mark as AI-generated, and here "
      + "this place cannot carry a machine-readable mark; the model's runtime does not watermark text.");
    expect(r.entries(ProvenanceEntryTypes.refused)[0]!.data).toMatchObject({
      tool: "add_note", argument: "text",
      missing: [{ layer: "metadata", method: "host", reason: "sink-cannot-carry" }, { layer: "watermark", method: "model", reason: "runtime-without-watermark" }],
    });
    expect(result.notices).toContainEqual(expect.objectContaining({ outcome: "provenance_refused", stage: "tool", category: "provenance" }));
    expect(r.gateway.provenanceRecords).toEqual([]); // refused before anything was signed
    expect(r.gateway.placements).toEqual([]);
    expect(r.entries(ProvenanceEntryTypes.placed)).toEqual([]);
  });

  it("places unmarked when the server cannot sign, and refuses with `refuse`", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const recorded = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } }, { gateway: { provenance: watermarked } });
    recorded.gateway.setProvenanceDown(true);
    await recorded.session.send("Write it.");
    expect(seen[0]!.recordId).toBeUndefined();
    expect(editor.html).toBe(LONG); // no id the server knows: no mark
    expect(seen[0]!.layers).toEqual([
      { layer: "metadata", method: "signed-record", applied: false, reason: "server-unavailable" },
      { layer: "watermark", method: "model", applied: false, reason: "server-unavailable" },
    ]);
    expect(seen[0]!.missing).toEqual([
      { layer: "metadata", method: "signed-record", reason: "server-unavailable" }, { layer: "watermark", method: "model", reason: "server-unavailable" },
    ]);
    expect(recorded.entries(ProvenanceEntryTypes.placed)[0]!.data).toMatchObject({ record_id: null, signed: false, reported: false });
    const refused = await run([fillField(new Editor())], { tool: "fill_field", args: { text: LONG } },
      { agent: { provenancePolicy: { on_missing: "refuse" } }, gateway: { provenance: watermarked } });
    await refused.session.send("While the server is up: the policy is known."); // placed
    refused.gateway.setProvenanceDown(true);
    await refused.session.send("Write it.");
    // The unsigned receipt is known first: refused before a record is asked for.
    expect(refused.toolResult()).toContain("the answer's receipt could not be signed");
    expect(refused.gateway.requests.filter((q) => q.path.endsWith("/provenance/records"))).toHaveLength(1); // the first turn's
  });

  it("refuses with `refuse` when only the record cannot be signed", async () => {
    let inserted = false;
    const tool = defineTool<{ text: string }>({
      name: "add_note", toolClass: "write", output: { argument: "text", mediaType: "text/html", edit: "generated" },
      run: async ({ text }, context) => provenanceOf(context).place({ content: text, mediaType: "text/html", sink: new Editor().sink }, () => {
        inserted = true;
      }),
    });
    // Receipts are signed, records are not: a signer that fails.
    const backend = new MemoryBackend({ on_missing: "refuse" });
    backend.signRecord = () => Promise.reject(new Error("the signer is down"));
    const r = await run([tool], { tool: "add_note", args: { text: LONG } }, { gateway: { provenance: watermarked }, module: { backend } });
    await r.session.send("Note it.");
    expect(inserted).toBe(false);
    expect(r.toolResult()).toBe("Error: Not written: this agent only places content it can mark as AI-generated, and here "
      + "the provenance service could not sign a record of it.");
    expect(backend.reports).toEqual([]);
    expect(r.entries(ProvenanceEntryTypes.refused)[0]!.data["missing"]).toEqual([{ layer: "metadata", method: "signed-record", reason: "server-unavailable" }]);
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
    expect(r.entries(ProvenanceEntryTypes.unmarked)[0]!.data).toMatchObject({
      tool: "insert_text", argument: "text", edit_kind: "generated", media_type: "text/markdown", length_class: "medium", reported: true,
    });
    const report = r.gateway.placements[0]!.report;
    expect(report).toEqual({ tool: "insert_text", sink_kind: "unmarked", media_type: "text/markdown", edit_kind: "generated", length_class: "medium", layers: [] });
    expect(validate(placementSchema, report)).toEqual([]);
  });

  it("fails the call in development", async () => {
    const r = await run([sloppy], { tool: "insert_text", args: { text: LONG } }, { module: { development: true } });
    await r.session.send("Go");
    expect(r.toolResult()).toMatch(/^Error: 'insert_text' declares content for people in 'text' and did not place it through place\(\)/);
  });

  it("leaves exempt kinds, labels and tools without content alone", async () => {
    const translate = defineTool<{ text: string }>({
      name: "translate", toolClass: "write", output: { argument: "text", mediaType: "text/plain", edit: "translated" }, run: () => "ok",
    });
    const r = await run([translate], { tool: "translate", args: { text: LONG } }, { module: { development: true } });
    await r.session.send("Go");
    expect(r.toolResult()).toBe("ok");
    expect(r.entries(ProvenanceEntryTypes.unmarked)).toEqual([]);
    const label = await run([sloppy], { tool: "insert_text", args: { text: "Approved" } }, { module: { development: true } });
    await label.session.send("Go");
    expect(label.toolResult()).toBe("inserted, without place()");
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
    expect(seen[0]).toMatchObject({ editKind: "corrected", exempt: true, reason: "exempt-edit", exemptBecause: "edit-kind" });
    const entry = r.entries(ProvenanceEntryTypes.placed)[0]!.data;
    expect(entry).toMatchObject({ edit_kind: "corrected", classified: { from: "rewritten", to: "corrected", reason: expect.stringMatching(/^small change: /) } });
    expect(JSON.stringify(r.gateway.placements)).not.toContain("small change");
  });

  it("ignores a classifier that lowers the kind to an exempt one without a reason, and records that", async () => {
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const r = await run([fillField(editor, {}, seen)], { tool: "fill_field", args: { text: LONG } },
      { module: { classifier: { classify: () => ({ kind: "corrected" }) } } });
    await r.session.send("Go");
    expect(seen[0]).toMatchObject({ editKind: "generated", exempt: false });
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data["classified"]).toEqual({
      from: "generated", to: "generated", reason: "corrected without a reason: not taken",
    });
  });

  it("adds an enricher's facts under its namespace and drops what looks personal", async () => {
    const files = new Map<string, string>();
    const tool = defineTool<{ text: string }>({
      name: "save_file", toolClass: "write", output: { argument: "text", mediaType: "text/markdown", edit: "summarised" },
      run: async ({ text }, context) => {
        const sidecar = { fileName: "Summary.md", write: (n: string, t: string) => void files.set(n, t), read: (n: string) => files.get(n) };
        const sink: SinkInfo = { kind: "file", container: true, carries: ["sidecar"], sidecar };
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
    const signed = r.gateway.provenanceRecords[0]!.signed;
    const sidecar = JSON.parse(files.get("Summary.md.provenance.json")!) as Record<string, unknown>;
    expect(sidecar).toEqual({
      contract: "provenance/v1", record: signed.record, signature: signed.signature,
      facts: { "com.example.matter": "M-2026-118", "com.example.urgent": true },
    });
    expect(JSON.stringify(sidecar)).not.toContain("erika");
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data).toMatchObject({
      facts: { "com.example.matter": "M-2026-118", "com.example.urgent": true },
      dropped_facts: ["com.example.owner: looks like personal data (e-mail address)", "c2pa: not a namespace of the integrator's own"],
    });
    expect(new ProvenanceReader().fromSidecar(files.get("Summary.md.provenance.json")!)[0]!.recordId).toBe(signed.record.id);
    expect(JSON.stringify(r.gateway.placements)).not.toContain("M-2026-118"); // facts stay on the device
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
