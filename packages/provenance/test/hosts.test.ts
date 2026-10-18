import { describe, expect, it } from "vitest";

import { defineTool, type AgentTool } from "@fadenstack/agents";
import {
  ProvenanceEntryTypes,
  ProvenanceReader,
  UnicodeTextMarker,
  provenanceOf,
  type ContentMarker,
  type KeyValueSink,
  type Placement,
  type PlaceRequest,
  type SinkInfo,
} from "@fadenstack/provenance";

import { LONG, markedPicture, run } from "./helpers.js";

/** A tool that places its `text` (or a picture) into `sink` and keeps the placement. */
function placing(sink: SinkInfo, request: Partial<PlaceRequest>, seen: Placement<unknown>[], kept: { content?: unknown } = {}): AgentTool {
  return defineTool<{ text: string }>({
    name: "place_it",
    toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { argument: "text", mediaType: request.mediaType ?? "text/plain", edit: "generated" },
    run: async ({ text }, context) => {
      seen.push(await provenanceOf(context).place({ content: text, mediaType: "text/plain", sink, ...request }, (marked) => {
        kept.content = marked.content;
      }));
      return "ok";
    },
  });
}

describe("integration levels", () => {
  it("level 0: a sink that carries nothing still gets a record; free text needs only the watermark", async () => {
    const seen: Placement<unknown>[] = [];
    const terminal: SinkInfo = { kind: "terminal", container: false, carries: [] };
    const r = await run([placing(terminal, {}, seen)], { tool: "place_it", args: { text: LONG } },
      { gateway: { provenance: { receipts: true, watermark: { applied: "model", algorithm: "vllm-gumbel" } } } });
    await r.session.send("Print it.");
    expect(seen[0]).toMatchObject({ signed: true, missing: [] });
    expect(r.gateway.provenanceRecords).toHaveLength(1);
  });

  it("level 1: one field in a CRM keeps the record's id, and it reads back", async () => {
    const notes = new Map<string, Record<string, string>>([["note-7", {}]]);
    const crmField: KeyValueSink = {
      write: (key, value) => void (notes.get("note-7")![key] = value),
      read: (key) => notes.get("note-7")![key],
    };
    const seen: Placement<unknown>[] = [];
    const kept: { content?: unknown } = {};
    const sink: SinkInfo = { kind: "crm.note", carries: ["key-value"], keyValue: crmField };
    const r = await run([placing(sink, {}, seen, kept)], { tool: "place_it", args: { text: LONG } });
    await r.session.send("Add the note.");
    expect(kept.content).toBe(LONG); // the text itself is not changed
    expect(notes.get("note-7")!["ai-generated-record"]).toBe(seen[0]!.recordId);
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "key-value", applied: true });
    expect(new ProvenanceReader().fromKeyValue(notes.get("note-7")!["ai-generated-record"])[0]!.recordId).toBe(seen[0]!.recordId);
  });

  it("level 3: a marker of the integrator's own, for a host nothing else fits", async () => {
    const annotations: string[] = [];
    const cadMarker: ContentMarker = {
      name: "cad-annotation", layer: "metadata",
      supports: (sink) => sink.carries.includes("cad-annotation"),
      attach: (_placed, record) => {
        annotations.push(`AI:${record.id}`);
        return { applied: true, method: "cad-annotation", verified: false };
      },
    };
    const seen: Placement<unknown>[] = [];
    const sink: SinkInfo = { kind: "cad.drawing", carries: ["cad-annotation"] };
    const r = await run([placing(sink, {}, seen)], { tool: "place_it", args: { text: LONG } }, { module: { markers: [cadMarker] } });
    await r.session.send("Annotate.");
    expect(annotations).toEqual([`AI:${seen[0]!.recordId}`]);
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "cad-annotation:unverified", applied: true });
  });
});

describe("pictures", () => {
  const slide: SinkInfo = { kind: "slide", carries: [] };

  it("are placed as the same bytes, checked for their C2PA, and signed by their own receipt", async () => {
    const seen: Placement<unknown>[] = [];
    const kept: { content?: unknown } = {};
    const bytes = markedPicture();
    const tool = defineTool({
      name: "add_image", toolClass: "write",
      run: async (_, context) => {
        seen.push(await provenanceOf(context).place({ content: bytes, mediaType: "image/png", sink: slide, receiptId: "picture-receipt-1" }, (m) => {
          kept.content = m.content;
        }));
        return "ok";
      },
    });
    const r = await run([tool], { tool: "add_image", args: {} });
    await r.session.send("Add the picture.");
    expect(kept.content).toBe(bytes);
    expect(r.gateway.provenanceRecords[0]!.request).toMatchObject({ media_type: "image/png", receipt_id: "picture-receipt-1" });
    expect(seen[0]!.layers).toEqual([
      { layer: "metadata", method: "signed-record", applied: true },
      { layer: "metadata", method: "c2pa+xmp:unverified", applied: true },
      { layer: "watermark", method: "trustmark:unverified", applied: true },
    ]);
    expect(seen[0]!.missing).toEqual([]);
  });

  it("that lost their C2PA are recorded as stripped by the host, and refused with refuse", async () => {
    const tool = (seen: Placement<unknown>[]) => defineTool({
      name: "add_image", toolClass: "write",
      run: async (_, context) => {
        seen.push(await provenanceOf(context).place({ content: markedPicture(false, false), mediaType: "image/png", sink: slide }, () => undefined));
        return "ok";
      },
    });
    const seen: Placement<unknown>[] = [];
    const recorded = await run([tool(seen)], { tool: "add_image", args: {} });
    await recorded.session.send("Add it.");
    expect(seen[0]!.missing).toEqual([{ layer: "metadata", reason: "stripped-by-host" }, { layer: "watermark", reason: undefined }]);
    const refused = await run([tool([])], { tool: "add_image", args: {} }, { agent: { provenancePolicy: { on_missing: "refuse" } } });
    await refused.session.send("Add it.");
    expect(refused.toolResult()).toMatch(/^Error: Not placed: .*the host removed the mark/);
  });

  it("can come as a data: URL", async () => {
    const seen: Placement<unknown>[] = [];
    const url = `data:image/png;base64,${btoa(String.fromCharCode(...markedPicture()))}`;
    const r = await run([placing(slide, { mediaType: "image/png", content: url }, seen)], { tool: "place_it", args: { text: "x" } });
    await r.session.send("Add it.");
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "c2pa+xmp:unverified", applied: true });
  });
});

describe("optional layers", () => {
  it("adds the visible label while the policy asks for one, in the user's language", async () => {
    const seen: Placement<unknown>[] = [];
    const kept: { content?: unknown } = {};
    const sink: SinkInfo = { kind: "crm.note", carries: ["key-value"], keyValue: { write: () => undefined, read: () => undefined } };
    const r = await run([placing(sink, {}, seen, kept)], { tool: "place_it", args: { text: LONG } }, { agent: { provenancePolicy: { visible_label: true } } });
    await r.session.send("Add the note.");
    expect(String(kept.content)).toBe(`AI-generated\n\n${LONG}`);
    expect(seen[0]!.layers).toContainEqual({ layer: "label", method: "visible-label:unverified", applied: true });
  });

  it("writes invisible text marks only where the integrator adds the marker and the sink keeps them", async () => {
    const seen: Placement<unknown>[] = [];
    const kept: { content?: unknown } = {};
    const sink: SinkInfo = { kind: "chat.message", carries: ["unicode-text"], readBack: () => String(kept.content) };
    const r = await run([placing(sink, {}, seen, kept)], { tool: "place_it", args: { text: LONG } }, { module: { markers: [new UnicodeTextMarker()] } });
    await r.session.send("Post it.");
    expect(new ProvenanceReader().fromText(String(kept.content))).toEqual([{ carrier: "unicode-text", recordId: seen[0]!.recordId }]);
    const without = await run([placing(sink, {}, [], kept)], { tool: "place_it", args: { text: LONG } });
    await without.session.send("Post it.");
    expect(kept.content).toBe(LONG);
  });
});

describe("a marker that fails", () => {
  const broken: ContentMarker = {
    name: "broken", layer: "metadata", supports: () => true,
    attach: () => {
      throw new Error("the host's API is down");
    },
  };

  it("is recorded, and the content is placed", async () => {
    const seen: Placement<unknown>[] = [];
    const r = await run([placing({ kind: "crm.note", carries: [] }, {}, seen)], { tool: "place_it", args: { text: LONG } }, { module: { markers: [broken] } });
    await r.session.send("Go");
    expect(seen[0]!.layers).toContainEqual({ layer: "metadata", method: "broken", applied: false });
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data["marker_errors"]).toEqual(["broken"]);
  });

  it("fails the call in development, after it is recorded", async () => {
    const r = await run([placing({ kind: "crm.note", carries: [] }, {}, [])], { tool: "place_it", args: { text: LONG } },
      { module: { markers: [broken], development: true } });
    await r.session.send("Go");
    expect(r.toolResult()).toBe("Error: the host's API is down");
    expect(r.entries(ProvenanceEntryTypes.placed)).toHaveLength(1);
    expect(r.gateway.placements).toHaveLength(1);
  });
});
