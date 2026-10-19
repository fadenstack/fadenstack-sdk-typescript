import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EDIT_KINDS,
  MARK_LAYERS,
  PLACEMENT_FAILURE,
  REASON_CODES,
  digitalSourceType,
  normalizeText,
  textSha256,
  bytesSha256,
  type Anchors,
  type DetectorInfo,
  type GenerationReceipt,
  type LayerOutcome,
  type LengthClass,
  type ModelInfo,
  type PlacementReport,
  type ProvenancePolicy,
  type ProvenanceRecordPayload,
  type RecordRequest,
  type SignedReceipt,
  type SignedRecord,
  type SystemInfo,
  type VerifyFinding,
  type VerifyRequest,
  type VerifyResult,
  type WatermarkStatus,
} from "@fadenstack/client";

import { CONTRACT_DIR, contractSchema, contractSchemaNames, type Schema } from "./jsonSchema.js";

/** Every field of `T`, with whether it is required: the compiler checks this against the type, the test against the schema. */
type FieldMap<T> = { readonly [K in keyof T]-?: undefined extends T[K] ? "optional" : "required" };
/** Every member of a union, once: the compiler checks this against the type, the test against the schema's enum. */
type Members<T extends string> = { readonly [K in T]: true };

const LAYER_OUTCOME = {
  layer: "required", method: "required", applied: "required", reason: "optional", verified: "optional",
} satisfies FieldMap<LayerOutcome>;
const WATERMARK = {
  applied: "required", algorithm: "optional", vendor: "optional", reason: "optional", key_version: "optional",
  context_width: "optional", tokenizer: "optional",
} satisfies FieldMap<WatermarkStatus>;
const MODEL = { id: "required", version: "optional" } satisfies FieldMap<ModelInfo>;
const SYSTEM = { name: "required", version: "required" } satisfies FieldMap<SystemInfo>;
const RECEIPT = {
  contract: "optional", id: "required", kind: "required", model: "required", created_at: "required", watermark: "required",
  output_hash: "required", hash_key_version: "required",
} satisfies FieldMap<GenerationReceipt>;
const SIGNED_RECEIPT = { receipt: "required", signature: "required", timestamp: "optional" } satisfies FieldMap<SignedReceipt>;
const RECORD = {
  contract: "optional", id: "required", digital_source_type: "required", edit_kind: "required", system: "required",
  provider: "required", model: "optional", created_at: "required", receipt_id: "optional", media_type: "required",
  content_hash: "required", hash_key_version: "required", text_hash: "optional",
} satisfies FieldMap<ProvenanceRecordPayload>;
const SIGNED_RECORD = { record: "required", signature: "required", timestamp: "optional" } satisfies FieldMap<SignedRecord>;
const RECORD_REQUEST = {
  content_sha256: "required", text_sha256: "optional", media_type: "required", edit_kind: "required", receipt_id: "optional",
  model: "optional",
} satisfies FieldMap<RecordRequest>;
const PLACEMENT = {
  record_id: "optional", tool: "required", sink_kind: "required", media_type: "required", edit_kind: "required",
  length_class: "required", layers: "required", written: "optional", failure: "optional",
} satisfies FieldMap<PlacementReport>;
const POLICY = {
  on_missing: "optional", short_text_tokens: "optional", exempt_edit_kinds: "optional", internal_technical: "optional",
  visible_label: "optional", output_log: "optional",
} satisfies FieldMap<ProvenancePolicy>;
const DETECTOR = { id: "required", methods: "required" } satisfies FieldMap<DetectorInfo>;
const ANCHORS = { contract: "optional", signing_chains: "required", trust_anchors: "required", detector: "required" } satisfies FieldMap<Anchors>;
const VERIFY_REQUEST = { text: "optional", file: "optional", media_type: "optional", signed: "optional" } satisfies FieldMap<VerifyRequest>;
const FINDING = {
  layer: "required", method: "required", found: "required", detail: "required", record_id: "optional", receipt_id: "optional",
  score: "optional",
} satisfies FieldMap<VerifyFinding>;
const VERIFY_RESULT = {
  contract: "optional", verdict: "required", findings: "required", content_hash: "required", detector: "required",
  checked_at: "required", signature: "optional",
} satisfies FieldMap<VerifyResult>;

/** The schemas the SDK's types mirror; `omitted` are fields the SDK leaves out on purpose. */
const MIRRORED: { schema: string; fields: Record<string, "required" | "optional">; omitted?: string[] }[] = [
  { schema: "layer-outcome", fields: LAYER_OUTCOME },
  { schema: "watermark-status", fields: WATERMARK },
  { schema: "generation-receipt", fields: RECEIPT },
  { schema: "signed-receipt", fields: SIGNED_RECEIPT },
  { schema: "provenance-record", fields: RECORD },
  { schema: "signed-record", fields: SIGNED_RECORD },
  // The agent is the route's: /v1/agents/{agent}/provenance/records.
  { schema: "record-request", fields: RECORD_REQUEST, omitted: ["agent"] },
  { schema: "placement-report", fields: PLACEMENT },
  { schema: "provenance-policy", fields: POLICY },
  { schema: "detector-info", fields: DETECTOR },
  { schema: "anchors", fields: ANCHORS },
  { schema: "verify-request", fields: VERIFY_REQUEST },
  { schema: "verify-finding", fields: FINDING },
  { schema: "verify-result", fields: VERIFY_RESULT },
];

/** Schemas of the server's internal routes (gateway and engine), which no SDK sends or reads. */
const INTERNAL = ["capabilities", "engine-info", "error-detail", "image-mark-request", "image-mark-result", "placement-request", "receipt-request"];

function fieldsOf(schema: Schema): { required: string[]; properties: string[] } {
  return { required: [...(schema.required ?? [])].sort(), properties: Object.keys(schema.properties ?? {}).sort() };
}

function expectFields(schema: Schema, fields: Record<string, string>, omitted: string[] = []): void {
  const { required, properties } = fieldsOf(schema);
  expect(Object.keys(fields).filter((k) => fields[k] === "required").sort()).toEqual(required.filter((k) => !omitted.includes(k)));
  expect([...Object.keys(fields), ...omitted].sort()).toEqual(properties);
}

/** The values an enum keyword allows at `property`, through `anyOf` and local `$ref`s. */
function enumOf(schema: Schema, ...path: string[]): unknown[] {
  let node: Schema | undefined = schema;
  for (const key of path) node = node?.properties?.[key] ?? node?.items;
  const values = (n: Schema | undefined): unknown[] => {
    if (!n) return [];
    if (n.$ref) return values(schema.$defs?.[n.$ref.replace("#/$defs/", "")]);
    if (n.items) return values(n.items);
    if (n.anyOf) return n.anyOf.flatMap(values);
    return n.enum ?? [];
  };
  return values(node).sort();
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("the provenance/v1 contract", () => {
  it("mirrors each schema the SDK uses, field by field, and names the others", () => {
    for (const { schema, fields, omitted } of MIRRORED) expectFields(contractSchema(schema), fields, omitted);
    expect(sorted([...MIRRORED.map((m) => m.schema), ...INTERNAL])).toEqual(contractSchemaNames());
  });

  it("mirrors the nested objects too", () => {
    const record = contractSchema("provenance-record");
    expectFields(record.$defs!["ModelInfo"]!, MODEL);
    expectFields(record.$defs!["SystemInfo"]!, SYSTEM);
    expectFields(contractSchema("generation-receipt").$defs!["WatermarkStatus"]!, WATERMARK);
  });

  it("has the schemas' edit kinds, reason codes, layers and other values", () => {
    expect(enumOf(contractSchema("record-request"), "edit_kind")).toEqual(sorted(EDIT_KINDS));
    expect(enumOf(contractSchema("provenance-policy"), "exempt_edit_kinds")).toEqual(sorted(EDIT_KINDS));
    expect(enumOf(contractSchema("layer-outcome"), "reason")).toEqual(sorted(REASON_CODES));
    expect(enumOf(contractSchema("layer-outcome"), "layer")).toEqual(sorted(MARK_LAYERS));
    expect(enumOf(contractSchema("verify-finding"), "layer")).toEqual(sorted(MARK_LAYERS));
    const applied = { model: true, engine: true, upstream: true, none: true } satisfies Members<WatermarkStatus["applied"]>;
    expect(enumOf(contractSchema("watermark-status"), "applied")).toEqual(sorted(Object.keys(applied)));
    const kinds = { text: true, image: true } satisfies Members<GenerationReceipt["kind"]>;
    expect(enumOf(contractSchema("generation-receipt"), "kind")).toEqual(sorted(Object.keys(kinds)));
    const lengths = { short: true, medium: true, long: true } satisfies Members<LengthClass>;
    expect(enumOf(contractSchema("placement-report"), "length_class")).toEqual(sorted(Object.keys(lengths)));
    const missing = { record: true, refuse: true } satisfies Members<NonNullable<ProvenancePolicy["on_missing"]>>;
    expect(enumOf(contractSchema("provenance-policy"), "on_missing")).toEqual(sorted(Object.keys(missing)));
    const verdicts = { "ai-generated": true, "no-mark-found": true, inconclusive: true } satisfies Members<VerifyResult["verdict"]>;
    expect(enumOf(contractSchema("verify-result"), "verdict")).toEqual(sorted(Object.keys(verdicts)));
  });

  it("reports a placement as written by default, and a failure only as a short code", () => {
    const properties = contractSchema("placement-report").properties!;
    expect(properties["written"]).toMatchObject({ type: "boolean", default: true });
    expect(properties["failure"]!.anyOf![0]).toMatchObject({ type: "string", pattern: PLACEMENT_FAILURE.source, maxLength: 64 });
  });

  it("gives generated content its own source type, and every other kind the composite one", () => {
    expect(digitalSourceType("generated")).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
    for (const kind of EDIT_KINDS.filter((k) => k !== "generated")) {
      expect(digitalSourceType(kind)).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
    }
  });
});

interface Vector {
  input: string;
  normalized: string;
  sha256: string;
}

describe("text hashing", () => {
  const vectors = JSON.parse(readFileSync(new URL("text-hash-vectors.json", CONTRACT_DIR), "utf8")) as Vector[];
  // Made with the server's own implementation: the white space Python's \s and JavaScript's \s count differently.
  const edges = JSON.parse(readFileSync(new URL("fixtures/text-hash-edge-vectors.json", import.meta.url), "utf8")) as Vector[];

  it.each([...vectors, ...edges].map((v) => [JSON.stringify(v.input), v] as const))("hashes %s as the server does", async (_, v) => {
    expect(normalizeText(v.input)).toBe(v.normalized);
    expect(await textSha256(v.input)).toBe(v.sha256);
  });

  it("hashes bytes as they are", async () => {
    expect(await bytesSha256(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await bytesSha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
