import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PLACEMENT_FAILURE, normalizeText, placementFailure, textSha256 } from "@fadenstack/client";
import { englishStrings, germanStrings } from "@fadenstack/ui";
import {
  OfficeMarks,
  hasReaderText,
  invisibleMark,
  invisibleRecordIds,
  isCode,
  isLabel,
  isOfficeAnchor,
  officeAnchorBase,
  officeAnchorName,
  officeAnchorPart,
  officeCustomXmlPart,
  officeDocumentPropertyValue,
  officeRecordOfAnchor,
  officeRecordSpans,
  officeShapeRecords,
  officeShapeRecordsAfterWrite,
  readOfficeCustomXmlPart,
  splitOfficeAnchors,
  type OfficeAnchorSpan,
  type OfficeSpan,
  readerText,
  readerTextSha256,
  recordText,
  recordTextSha256,
  similarityClassifier,
  splitMarksInHtml,
  suggestEditKind,
  tokensOf,
  withFrontMatter,
  wrapHtml,
} from "@fadenstack/provenance";

/**
 * The marks byte for byte, with fixed inputs: the .NET SDK's tests (`SharedVectorTests`) hold the same strings, so both
 * SDKs write one format.
 */
const ID = "5a0e2b5c-7f3e-4a51-9a40-6a1c55e1d3f1";

describe("shared vectors (the .NET SDK has the same)", () => {
  it("invisible text: U+FEFF, then FDNP 01 and the id's bytes as variation selectors", () => {
    const expected = "\u{FEFF}\u{E0136}\u{E0134}\u{E013E}\u{E0140}\u{FE01}\u{E0125}\u{E0151}\u{E0120}\u{E0155}\u{E0122}\u{E0152}"
      + "\u{E0125}\u{E0153}\u{E011D}\u{E0127}\u{E0156}\u{E0123}\u{E0155}\u{E011D}\u{E0124}\u{E0151}\u{E0125}\u{E0121}\u{E011D}"
      + "\u{E0129}\u{E0151}\u{E0124}\u{E0120}\u{E011D}\u{E0126}\u{E0151}\u{E0121}\u{E0153}\u{E0125}\u{E0125}\u{E0155}\u{E0121}"
      + "\u{E0154}\u{E0123}\u{E0156}\u{E0121}";
    expect(invisibleMark(ID)).toBe(expected);
    expect([...expected]).toHaveLength(42);
    // An emoji's own variation selector just before the mark does not run into it.
    expect(invisibleRecordIds(`Thanks ❤\u{FE0F}${expected}`)).toEqual([ID]);
  });

  it("HTML: one element with data-ai-generated and the title, the label and the id; one paragraph is marked inside it", () => {
    const en = englishStrings.aiGeneratedTitle(ID);
    expect(wrapHtml("Hello", ID, en)).toBe(`<span data-ai-generated="${ID}" title="AI-generated ${ID}">Hello</span>`);
    expect(wrapHtml("<p>Hallo</p>", ID, germanStrings.aiGeneratedTitle(ID)))
      .toBe(`<p><span data-ai-generated="${ID}" title="KI-generiert ${ID}">Hallo</span></p>`);
    expect(wrapHtml('\n<P class="lead">Hi <b>there</b></P>\n', ID, en))
      .toBe(`\n<p class="lead"><span data-ai-generated="${ID}" title="AI-generated ${ID}">Hi <b>there</b></span></p>\n`);
    expect(wrapHtml("<p>One.</p><p>Two.</p>", ID, en)).toBe(`<div data-ai-generated="${ID}" title="AI-generated ${ID}"><p>One.</p><p>Two.</p></div>`);
    expect(wrapHtml("<p>One.</p><ul><li>Two</li></ul>", ID, en))
      .toBe(`<div data-ai-generated="${ID}" title="AI-generated ${ID}"><p>One.</p><ul><li>Two</li></ul></div>`);
    expect(wrapHtml("<pre>x</pre>", ID, en)).toBe(`<div data-ai-generated="${ID}" title="AI-generated ${ID}"><pre>x</pre></div>`);
  });

  it("front matter: the two keys, the id quoted, a blank line before a body without front matter", () => {
    expect(withFrontMatter("# Title\n", ID)).toBe(`---\nai-generated: true\nai-record-id: "${ID}"\n---\n\n# Title\n`);
    expect(withFrontMatter("---\ntitle: T\n---\nBody", ID)).toBe(`---\ntitle: T\nai-generated: true\nai-record-id: "${ID}"\n---\nBody`);
  });

  it("Office: the anchor, the custom XML part and the document property", () => {
    const anchor = officeAnchorName(ID);
    expect(anchor).toBe("_faden_ai_5a0e2b5c7f3e4a519a406a1c");
    expect(isOfficeAnchor(anchor)).toBe(true);
    const part = officeCustomXmlPart([{ recordId: ID, anchor, signature: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln", timestamp: "MIIBAQ==" }]);
    expect(part).toBe('<provenance xmlns="https://fadenstack.com/ns/provenance/1.0">'
      + `<record id="${ID}" anchor="_faden_ai_5a0e2b5c7f3e4a519a406a1c" timestamp="MIIBAQ==">eyJhbGciOiJFUzI1NiJ9.e30.c2ln</record></provenance>`);
    expect(readOfficeCustomXmlPart(part)).toEqual([{ recordId: ID, anchor, signature: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln", timestamp: "MIIBAQ==" }]);
    expect(officeCustomXmlPart([])).toBe('<provenance xmlns="https://fadenstack.com/ns/provenance/1.0" />');
    const other = "0b6f9a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(officeDocumentPropertyValue([ID, other])).toBe(`true ${other} ${ID}`);
    expect(() => officeAnchorName("rec-1")).toThrow(TypeError);
  });

  it("what needs no mark: labels, code; and how tokens are counted", () => {
    for (const label of ["Approved", "Q3 revenue", "Due in March", "已批准", ""]) expect(isLabel(label)).toBe(true);
    for (const text of ["Approved.", "One two three four", "a".repeat(41), "这是一个很长的中文句子内容", "Ok; next"]) expect(isLabel(text)).toBe(false);
    for (const type of ["application/json", "text/x-python", "application/ld+json", "image/svg+xml; x=1", "text/csv"]) {
      expect(isCode(type)).toBe(type !== "image/svg+xml; x=1" && type !== "text/csv");
    }
    expect(isCode("text/x-markdown")).toBe(false);
    expect(isCode("application/xhtml+xml")).toBe(false);
    expect(tokensOf("abcdefghi")).toBe(3);
    expect(tokensOf("人工智能 abc")).toBe(5); // four CJK characters and four others
  });

  it("a failed placement's code: the error's name, `_` for each other UTF-16 unit, 64 at most, Error for none", () => {
    const cases: [string | undefined, string][] = [
      ["RangeError", "RangeError"],
      ["InvalidOperationException", "InvalidOperationException"],
      ["InsertFailedException`1", "InsertFailedException_1"],
      ["Host error: field gone!", "Host_error:_field_gone_"],
      ["Fehler.beim-Einfügen", "Fehler.beim-Einf_gen"],
      ["📎Error", "__Error"],
      ["A".repeat(70), "A".repeat(64)],
      ["", "Error"],
      [undefined, "Error"],
    ];
    for (const [name, code] of cases) {
      expect(placementFailure(name)).toBe(code);
      expect(PLACEMENT_FAILURE.test(code)).toBe(true);
    }
  });
});

interface ReaderTextVector {
  name: string;
  media_type: string;
  input: string;
  /** The text a reader sees, normalised as it is hashed; null: no text hash (not markup, or nothing to read). */
  text: string | null;
  sha256: string | null;
}

describe("the text a reader sees (reader-text-vectors.json; the .NET SDK reads the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("fixtures/reader-text-vectors.json", import.meta.url), "utf8")) as ReaderTextVector[];

  it("has the cases", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const text = hasReaderText(v.media_type) ? normalizeText(readerText(v.input, v.media_type)) : null;
    expect(text === "" ? null : text).toBe(v.text);
    expect((await readerTextSha256(v.input, v.media_type)) ?? null).toBe(v.sha256);
  });
});

interface EditKindVector {
  name: string;
  media_type: string;
  original: string;
  revised: string;
  kind: "corrected" | "rewritten";
  /** The reason the classifier records, word for word. */
  reason: string;
}

describe("the edit kind of a revision (edit-kind-vectors.json; the .NET SDK reads the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("fixtures/edit-kind-vectors.json", import.meta.url), "utf8")) as EditKindVector[];

  it("has the cases", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(13);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_, v) => {
    const decided = similarityClassifier().classify({ tool: "t", declared: "rewritten", mediaType: v.media_type, content: v.revised, original: v.original });
    expect(decided).toEqual({ kind: v.kind, reason: v.reason });
    expect(suggestEditKind(v.original, v.revised, { mediaType: v.media_type })).toBe(v.kind);
  });
});

/** A later write into marked HTML: `html` with `|` at the place, `split` with `|` where the write goes, `record` what R1 was placed from. */
interface MarkSplitVector {
  name: string;
  html: string;
  split: string;
  record: string;
}

interface RecordTextVector {
  name: string;
  html: string;
  record_id: string;
  /** The record's text, normalised as it is hashed; null: the HTML holds none of it. */
  text: string | null;
}

describe("marks split for a later write, and a record's text read back (mark-split-vectors.json; the .NET SDK reads the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("fixtures/mark-split-vectors.json", import.meta.url), "utf8")) as {
    split: MarkSplitVector[];
    record_text: RecordTextVector[];
  };
  const R1 = "5a0e2b5c-7f3e-4a51-9a40-6a1c55e1d3f1";
  const R2 = "0b6f9a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  /** What the agent writes later, marked as R2 (`wrapHtml`). */
  const later = wrapHtml("We are sorry for the trouble.", R2, englishStrings.aiGeneratedTitle(R2));

  it("has the cases", () => {
    expect(vectors.split.length).toBeGreaterThanOrEqual(11);
    expect(vectors.record_text.length).toBeGreaterThanOrEqual(7);
  });

  it.each(vectors.split.map((v) => [v.name, v] as const))("split: %s", async (_, v) => {
    const html = v.html.replace("|", "");
    const split = splitMarksInHtml(html, v.html.indexOf("|"));
    expect(`${split.html.slice(0, split.at)}|${split.html.slice(split.at)}`).toBe(v.split);
    // R1's text is still its record's -- before the later write, and after it, with R2's own beside it.
    const recorded = await readerTextSha256(v.record, "text/html");
    expect(await recordTextSha256(html, R1)).toBe(recorded);
    expect(await recordTextSha256(split.html, R1)).toBe(recorded);
    const written = split.html.slice(0, split.at) + later + split.html.slice(split.at);
    expect(await recordTextSha256(written, R1)).toBe(recorded);
    expect(await recordTextSha256(written, R2)).toBe(await textSha256("We are sorry for the trouble."));
  });

  it("split: a place inside a tag, a comment or a character reference is refused", () => {
    expect(() => splitMarksInHtml("<p>a</p>", 2)).toThrow(RangeError);
    expect(() => splitMarksInHtml("a<!-- b -->c", 4)).toThrow(RangeError);
    expect(() => splitMarksInHtml("a&amp;b", 3)).toThrow(RangeError);
    expect(() => splitMarksInHtml("ab", 3)).toThrow(RangeError);
    expect(splitMarksInHtml("a&amp;b", 6)).toEqual({ html: "a&amp;b", at: 6 });
  });

  it.each(vectors.record_text.map((v) => [v.name, v] as const))("record text: %s", async (_, v) => {
    expect(normalizeText(recordText(v.html, v.record_id)) || null).toBe(v.text);
    expect((await recordTextSha256(v.html, v.record_id)) ?? null).toBe(v.text === null ? null : await textSha256(v.text));
  });
});

/** A later write into a Word document's anchors: the story's text and its anchors after Word's insert, what was written. */
interface AnchorSplitVector {
  name: string;
  text: string;
  anchors: OfficeAnchorSpan[];
  written: OfficeSpan[];
  own: string;
  taken: string[];
  /** Every bookmark as it must be after the split. */
  after: OfficeAnchorSpan[];
  /** Each record's text read back from its anchors, exactly; null: none. */
  records: Record<string, string | null>;
}

interface RecordSpansVector {
  name: string;
  text: string;
  anchors: OfficeAnchorSpan[];
  record: string;
  record_text: string | null;
}

describe("Office anchors: names, parts, a later write's split, a record's text (office-anchor-vectors.json; the .NET SDK reads the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("fixtures/office-anchor-vectors.json", import.meta.url), "utf8")) as {
    names: { name: string; anchor: string | null; base: string | null }[];
    parts: { name: string; anchor: string; part: number; result: string | null }[];
    split: AnchorSplitVector[];
    record_spans: RecordSpansVector[];
  };
  const byName = (a: OfficeAnchorSpan, b: OfficeAnchorSpan) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const textOf = (text: string, spans: readonly OfficeSpan[]) => (spans.length ? spans.map((s) => text.slice(s.start, s.end)).join("") : null);

  it("has the cases", () => {
    expect(vectors.names.length).toBeGreaterThanOrEqual(20);
    expect(vectors.parts.length).toBeGreaterThanOrEqual(6);
    expect(vectors.split.length).toBeGreaterThanOrEqual(14);
    expect(vectors.record_spans.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectors.names.map((v) => [v.name, v] as const))("name: %s", (_, v) => {
    expect(officeAnchorBase(v.anchor)).toBe(v.base);
    expect(isOfficeAnchor(v.anchor)).toBe(v.base !== null);
    if (v.base !== null) expect(v.anchor!.length).toBeLessThanOrEqual(OfficeMarks.anchorMaxLength);
  });

  it.each(vectors.parts.map((v) => [v.name, v] as const))("part: %s", (_, v) => {
    if (v.result === null) expect(() => officeAnchorPart(v.anchor, v.part)).toThrow();
    else expect(officeAnchorPart(v.anchor, v.part)).toBe(v.result);
  });

  it.each(vectors.split.map((v) => [v.name, v] as const))("split: %s", (_, v) => {
    const { set, removed } = splitOfficeAnchors(v.anchors, v.written, v.own, v.taken);
    const now = new Map(v.anchors.map((a) => [a.name, a]));
    for (const name of removed) now.delete(name);
    for (const a of set) now.set(a.name, a);
    expect([...now.values()].map((a) => ({ name: a.name, start: a.start, end: a.end })).sort(byName)).toEqual([...v.after].sort(byName));
    for (const [record, text] of Object.entries(v.records)) expect(textOf(v.text, officeRecordSpans([...now.values()], record))).toBe(text);
    // Done again, nothing changes: what it left holds nothing written of another record's.
    expect(splitOfficeAnchors([...now.values()], v.written, v.own, v.taken)).toEqual({ set: [], removed: [] });
  });

  it.each(vectors.record_spans.map((v) => [v.name, v] as const))("record spans: %s", (_, v) => {
    expect(textOf(v.text, officeRecordSpans(v.anchors, v.record))).toBe(v.record_text);
  });

  it("every part number taken: the text after the write stays without an anchor", () => {
    const r1 = officeAnchorName(ID);
    const r2 = officeAnchorName("0b6f9a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    const taken = Array.from({ length: 98 }, (_, i) => officeAnchorPart(r1, i + 2));
    const split = splitOfficeAnchors([{ name: r1, start: 0, end: 20 }, { name: r2, start: 5, end: 10 }], [{ start: 5, end: 10 }], r2, taken);
    expect(split).toEqual({ set: [{ name: r1, start: 0, end: 5 }], removed: [] });
  });

  it("a part maps to its record in the custom XML part", () => {
    const other = "0b6f9a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const records = readOfficeCustomXmlPart(officeCustomXmlPart([
      { recordId: ID, anchor: officeAnchorName(ID), signature: "eyJ.e30.a" },
      { recordId: other, anchor: "", signature: "eyJ.e30.b" }, // no anchor written: the id's
    ]));
    expect(officeRecordOfAnchor(records, officeAnchorPart(officeAnchorName(ID), 7))?.recordId).toBe(ID);
    expect(officeRecordOfAnchor(records, officeAnchorName(ID).toUpperCase().replace("_FADEN_AI_", "_faden_ai_"))?.recordId).toBe(ID);
    expect(officeRecordOfAnchor(records, `${officeAnchorName(other)}_2`)?.recordId).toBe(other);
    expect(officeRecordOfAnchor(records, "_faden_ai_7d1e8f203a4b4c5d9e6fa0b1")).toBeUndefined();
    expect(officeRecordOfAnchor(records, "_Toc1")).toBeUndefined();
  });
});

describe("PowerPoint's shape tags: the records a shape holds, and its list after a write (office-shape-vectors.json; the .NET SDK reads the same file)", () => {
  const vectors = JSON.parse(readFileSync(new URL("fixtures/office-shape-vectors.json", import.meta.url), "utf8")) as {
    read: { name: string; records: string | null; record: string | null; ids: string[] }[];
    after_write: { name: string; records: string | null; record: string | null; record_id: string; partial: boolean; value: string }[];
  };

  it("has the cases", () => {
    expect(OfficeMarks.shapeRecordsTag).toBe("FADEN_AI_RECORDS");
    expect(vectors.read.length).toBeGreaterThanOrEqual(8);
    expect(vectors.after_write.length).toBeGreaterThanOrEqual(8);
  });

  it.each(vectors.read.map((v) => [v.name, v] as const))("read: %s", (_, v) => {
    expect(officeShapeRecords(v.records, v.record)).toEqual(v.ids);
  });

  it.each(vectors.after_write.map((v) => [v.name, v] as const))("after a write: %s", (_, v) => {
    const value = officeShapeRecordsAfterWrite(v.records, v.record, v.record_id, v.partial);
    expect(value).toBe(v.value);
    // Read back with FADEN_AI_RECORD set to the record: the list as written, the record last.
    expect(officeShapeRecords(value, v.record_id)).toEqual(value.split(" "));
  });

  it("a write needs a record id", () => {
    expect(() => officeShapeRecordsAfterWrite(null, null, "rec-1", true)).toThrow(TypeError);
  });
});
