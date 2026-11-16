import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { textSha256 } from "@fadenstack/client";
import { AgentDefinition, FadenstackAgent, MemoryApprovalStore, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { ProvenanceEntryTypes, ProvenanceReader, provenanceModule } from "@fadenstack/provenance";
import { EndpointDialect } from "@fadenstack/client";
import { OpenAiFake } from "@fadenstack/testing";

import { contractSchema, validate } from "../../client/test/jsonSchema.js";
import { LONG, run, type Run } from "./helpers.js";

/** The mark on copy: what the person copies out of the chat goes through the placement pipeline as the tool `copy`. */
const noop = defineTool<Record<string, never>>({ name: "noop", toolClass: "write", parameters: { type: "object", properties: {} }, run: () => "ok" });
const placementSchema = contractSchema("placement-report");

async function answered(options: Parameters<typeof run>[2] = {}): Promise<{ r: Run; turn: string }> {
  const r = await run([noop], { tool: "noop", args: {} }, options);
  await r.session.send("Answer the customer.");
  return { r, turn: r.session.transcript.filter((e) => e.turnId).at(-1)!.turnId! };
}

describe("the mark on copy", () => {
  it("is one placement with the sink clipboard, linked to the turn's receipt, the HTML marked and the text as it was", async () => {
    const { r, turn } = await answered();
    const html = `<p>${LONG}</p>`;

    const copied = await r.agent.markCopy({ text: LONG, html, chat: r.session.id, turn });

    expect(copied.marked).toBe(true);
    expect(copied.refused).toBeUndefined();
    expect(copied.text).toBe(LONG);
    const id = r.gateway.provenanceRecords[0]!.signed.record.id;
    expect(copied.recordId).toBe(id);
    expect(copied.html!.startsWith(`<p><span data-ai-generated="${id}" title="AI-generated ${id}">The delivery`)).toBe(true);
    expect(new ProvenanceReader().fromHtml(copied.html!)).toEqual([{ carrier: "html-attribute", recordId: id }, { carrier: "html-title", recordId: id }]);

    expect(r.gateway.provenanceRecords).toHaveLength(1);
    expect(r.gateway.provenanceRecords[0]!.request).toEqual({
      content_sha256: await textSha256(html), text_sha256: await textSha256(LONG), media_type: "text/html", edit_kind: "generated",
      receipt_id: r.gateway.receipts.at(-1)!.id, model: "fake-model",
    });
    const report = r.gateway.placements[0]!.report;
    expect(validate(placementSchema, report)).toEqual([]);
    expect(report).toMatchObject({ record_id: id, tool: "copy", sink_kind: "clipboard", media_type: "text/html", edit_kind: "generated" });
    expect(JSON.stringify(report)).not.toContain("delivery"); // never content
    const entry = r.entries(ProvenanceEntryTypes.placed)[0]!;
    expect(entry.data).toMatchObject({ tool: "copy", sink_kind: "clipboard", record_id: id, receipt_id: r.gateway.receipts.at(-1)!.id, exempt: false });
    expect(entry.turnId).toBe(turn);
    expect(JSON.stringify(entry.data)).not.toContain("delivery");
  });

  it("comes back as it is without the module", async () => {
    const { r } = await answered({ withoutModule: true });
    expect(await r.agent.markCopy({ text: "Hello", html: "<p>Hello</p>" })).toEqual({ text: "Hello", html: "<p>Hello</p>", marked: false });
    expect(r.gateway.provenanceRecords).toEqual([]);
  });

  it("copies code as it is and records it as exempt, with no record", async () => {
    const { r, turn } = await answered();
    const copied = await r.agent.markCopy({ text: "var x = 1;", html: "<pre><code>var x = 1;</code></pre>", chat: r.session.id, turn, code: true });
    expect(copied).toEqual({ text: "var x = 1;", html: "<pre><code>var x = 1;</code></pre>", marked: false, exemptBecause: "code" });
    expect(r.gateway.provenanceRecords).toEqual([]);
    expect(r.entries(ProvenanceEntryTypes.placed)[0]!.data).toMatchObject({ tool: "copy", exempt: true, exempt_because: "code" });
  });

  it("signs text without HTML and leaves it as it is", async () => {
    const { r, turn } = await answered();
    const copied = await r.agent.markCopy({ text: LONG, chat: r.session.id, turn });
    expect(copied).toMatchObject({ text: LONG, marked: false, recordId: r.gateway.provenanceRecords[0]!.signed.record.id });
    expect(copied.html).toBeUndefined();
    expect(r.gateway.provenanceRecords[0]!.request["media_type"]).toBe("text/markdown");
  });

  it("copies nothing under the policy `refuse` when it cannot be marked, and says so", async () => {
    const { r, turn } = await answered({ agent: { provenancePolicy: { on_missing: "refuse" } } });
    await r.agent.markCopy({ text: "x", code: true, chat: r.session.id, turn }); // the policy is read while the server answers
    r.gateway.setProvenanceDown(true);
    const copied = await r.agent.markCopy({ text: "Hello there.", html: "<p>Hello there.</p>", chat: r.session.id, turn });
    expect(copied).toEqual({ text: "Hello there.", marked: false, refused: true });
    expect(r.entries(ProvenanceEntryTypes.refused)).toHaveLength(1);
    expect(r.entries(ProvenanceEntryTypes.placed)).toHaveLength(1); // the code only
    expect(r.gateway.placements.map((p) => p.report.media_type)).toEqual(["text/x-code"]); // nothing of the refused copy is reported
  });

  it("copies unmarked under the default policy when the server cannot sign", async () => {
    const { r, turn } = await answered();
    await r.agent.markCopy({ text: "x", code: true, chat: r.session.id, turn });
    r.gateway.setProvenanceDown(true);
    const copied = await r.agent.markCopy({ text: "Hello there.", html: "<p>Hello there.</p>", chat: r.session.id, turn });
    expect(copied).toEqual({ text: "Hello there.", html: "<p>Hello there.</p>", marked: false });
  });

  it("marks a saved Markdown export in its front matter (sink file)", async () => {
    const { r, turn } = await answered();
    const copied = await r.agent.markCopy({ text: `# Chat\n\n${LONG}\n`, chat: r.session.id, turn, file: true });
    const id = r.gateway.provenanceRecords[0]!.signed.record.id;
    expect(copied.marked).toBe(true);
    expect(copied.text.startsWith(`---\nai-generated: true\nai-record-id: "${id}"\n---\n`)).toBe(true);
    expect(copied.text).toContain(LONG);
    expect(r.gateway.placements[0]!.report).toMatchObject({ tool: "copy", sink_kind: "file", media_type: "text/markdown" });
  });

  it("is signed by the device on an agent without a server", async () => {
    const fake = new OpenAiFake();
    fake.answers.push(OpenAiFake.text("Done."));
    const agent = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "docs-assistant" }))
      .useSessionStore(new MemorySessionStore())
      .useApprovalStore(new MemoryApprovalStore())
      .use(provenanceModule({ localBackend: { indexedDB: new IDBFactory(), timestampAuthority: null } }))
      .build();
    const copied = await agent.markCopy({ text: "Hello there.", html: "<p>Hello there.</p>" });
    expect(copied.marked).toBe(true);
    expect(copied.html).toContain(`data-ai-generated="${copied.recordId}"`);
    expect(copied.text).toBe("Hello there.");
  });
});
