import { describe, expect, it } from "vitest";

import {
  FadenstackApiError,
  FadenstackClient,
  loginWithPassword,
  readReceiptEvent,
  readReceiptHeader,
  receiptIdOf,
  textSha256,
  type ChatUpdate,
} from "@fadenstack/client";
import { FakeGateway, type FakeGatewayOptions } from "@fadenstack/testing";

import { contractSchema, validate } from "./jsonSchema.js";

async function signedIn(options: FakeGatewayOptions = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "writer" }], ...options });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "writer", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  return { gateway, client };
}

async function collect(updates: AsyncIterable<ChatUpdate>): Promise<ChatUpdate[]> {
  const out: ChatUpdate[] = [];
  for await (const u of updates) out.push(u);
  return out;
}

/** The record request schema as the agents' route takes it: the agent is the route's. */
function agentRecordRequestSchema() {
  const schema = contractSchema("record-request");
  delete schema.properties!["agent"];
  return schema;
}

describe("the agent's provenance routes", () => {
  it("reads the policy, completed with the contract's defaults", async () => {
    const { client } = await signedIn({ provenance: { policy: { on_missing: "refuse", short_text_tokens: 120 } } });
    const policy = await client.agent!.provenance.policy();
    expect(policy).toEqual({
      on_missing: "refuse", short_text_tokens: 120, exempt_edit_kinds: ["translated", "corrected", "formatted", "extracted"],
      internal_technical: false, visible_label: false, output_log: false,
    });
    expect(validate(contractSchema("provenance-policy"), policy)).toEqual([]);
  });

  it("signs a record by the content's hash, and keeps the signed record as it came", async () => {
    const { gateway, client } = await signedIn();
    const sha = await textSha256("Dear Ms Huber, the pump is due for a seal check.");
    const signed = await client.agent!.provenance.signRecord({ content_sha256: sha, media_type: "text/html", edit_kind: "generated", receipt_id: "r-1" });
    const sent = gateway.requests.find((r) => r.path === "/v1/agents/writer/provenance/records")!;
    expect(sent.body).toEqual({ content_sha256: sha, media_type: "text/html", edit_kind: "generated", receipt_id: "r-1" });
    expect(validate(agentRecordRequestSchema(), sent.body)).toEqual([]);
    expect(JSON.stringify(sent.body)).not.toContain("Huber"); // the hash only, never the content
    expect(validate(contractSchema("signed-record"), signed)).toEqual([]);
    expect(signed).toEqual(gateway.provenanceRecords[0]!.signed);
    expect(signed.record).toMatchObject({ edit_kind: "generated", receipt_id: "r-1", digital_source_type: expect.stringContaining("trainedAlgorithmicMedia") });
  });

  it("refuses a request that is not a hash or names no edit kind, before it goes out", async () => {
    const { gateway, client } = await signedIn();
    await expect(client.agent!.provenance.signRecord({ content_sha256: "the text itself", media_type: "text/plain", edit_kind: "generated" }))
      .rejects.toThrow(TypeError);
    await expect(client.agent!.provenance.signRecord({ content_sha256: "a".repeat(64), media_type: "text/plain", edit_kind: "made-up" as "generated" }))
      .rejects.toThrow(TypeError);
    expect(gateway.provenanceRecords).toEqual([]);
  });

  it("reports a placement in the contract's shape", async () => {
    const { gateway, client } = await signedIn();
    const report = {
      record_id: "3f2c8a8e-0000-4000-8000-000000000001", tool: "fill_field", sink_kind: "html.editor", media_type: "text/html",
      edit_kind: "generated" as const, length_class: "medium" as const,
      layers: [
        { layer: "metadata" as const, method: "html-title", applied: true },
        { layer: "watermark" as const, method: "none", applied: false, reason: "runtime-without-watermark" as const },
      ],
    };
    await client.agent!.provenance.reportPlacement(report);
    expect(gateway.placements).toEqual([{ agent: "writer", report }]);
    expect(validate(contractSchema("placement-report"), report)).toEqual([]);
  });

  it("says when the server has no provenance module, or its service is down", async () => {
    const without = await signedIn({ provenance: { enabled: false } });
    await expect(without.client.agent!.provenance.policy()).rejects.toMatchObject({ status: 404 });
    const down = await signedIn({ provenance: { down: true } });
    const error = await down.client.agent!.provenance.policy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FadenstackApiError);
    expect(error).toMatchObject({ status: 503, code: "provenance_unavailable" });
  });
});

describe("the server's provenance routes", () => {
  it("lists the anchors, in the contract's shape", async () => {
    const { client } = await signedIn();
    const anchors = await client.provenance.anchors();
    expect(validate(contractSchema("anchors"), anchors)).toEqual([]);
    expect(anchors.signing_chains[0]).toContain("BEGIN CERTIFICATE");
  });

  it("checks content against the records, keeping nothing", async () => {
    const { client } = await signedIn();
    const text = "The pump P-200 is due for a seal check next week.";
    const signed = await client.agent!.provenance.signRecord({ content_sha256: await textSha256(text), media_type: "text/plain", edit_kind: "generated" });
    const found = await client.provenance.verify({ text: `  ${text.replace(/ /g, "\n")} ` }); // reflowed: the same text
    expect(validate(contractSchema("verify-result"), found)).toEqual([]);
    expect(found).toMatchObject({ verdict: "ai-generated", findings: [{ found: true, record_id: signed.record.id }] });
    expect((await client.provenance.verify({ text: "Something a person wrote." })).verdict).toBe("no-mark-found");
  });
});

describe("receipts", () => {
  it("come at the end of a streamed answer, as an event and as a receipt", async () => {
    const { gateway, client } = await signedIn({ provenance: { receipts: true } });
    const updates = await collect(client.chat.stream([{ role: "user", content: "Write the reply." }]));
    const receipt = updates.find((u) => u.type === "receipt");
    expect(receipt).toMatchObject({ type: "receipt", receipt: { status: "signed", receipt: { id: gateway.receipts[0]!.id, kind: "text" } } });
    expect(updates.findIndex((u) => u.type === "receipt")).toBeGreaterThan(updates.findIndex((u) => u.type === "finish"));
    expect(updates.some((u) => u.type === "event" && u.event.name === "faden.provenance")).toBe(true);
    const signed = (receipt as { receipt: { receipt: unknown; signature: string } }).receipt;
    expect(validate(contractSchema("signed-receipt"), { receipt: signed.receipt, signature: signed.signature })).toEqual([]);
  });

  it("are unsigned, with the reason, when the server could not sign one", async () => {
    const { client } = await signedIn({ provenance: { receipts: true, down: true } });
    const updates = await collect(client.chat.stream([{ role: "user", content: "Write the reply." }]));
    expect(updates.find((u) => u.type === "receipt")).toEqual({ type: "receipt", receipt: { status: "unsigned", reason: "server-unavailable" } });
  });

  it("are named in a header when the answer is not streamed", async () => {
    const { gateway, client } = await signedIn({ provenance: { receipts: true } });
    const answer = await client.chat.complete([{ role: "user", content: "Write the reply." }]);
    expect(answer.receipts).toEqual([{ status: "reference", receiptId: gateway.receipts[0]!.id }]);
  });

  it("are none where the server sends none", async () => {
    const { client } = await signedIn();
    expect((await collect(client.chat.stream([{ role: "user", content: "Hi" }]))).some((u) => u.type === "receipt")).toBe(false);
    expect((await client.chat.complete([{ role: "user", content: "Hi" }])).receipts).toEqual([]);
  });

  it("are read strictly: a header's ids in order, an event of either shape, nothing else", () => {
    expect(readReceiptHeader(" r-1, r-2 ,,bad id,")).toEqual([{ status: "reference", receiptId: "r-1" }, { status: "reference", receiptId: "r-2" }]);
    expect(readReceiptHeader(null)).toEqual([]);
    expect(readReceiptEvent({ receipt: { id: "r-3" }, signature: "a.b.c" })).toMatchObject({ status: "signed", signature: "a.b.c" });
    expect(readReceiptEvent({ receipt: { id: "r-3" } })).toBeUndefined(); // a receipt without its signature is not one
    expect(readReceiptEvent({ receipt: null, status: "unsigned" })).toEqual({ status: "unsigned", reason: "server-unavailable" });
    expect(readReceiptEvent("r-4")).toBeUndefined();
    expect(receiptIdOf({ status: "reference", receiptId: "r-5" })).toBe("r-5");
    expect(receiptIdOf({ status: "unsigned", reason: "server-unavailable" })).toBeUndefined();
  });
});
