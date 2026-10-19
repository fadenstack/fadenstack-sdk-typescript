import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PLACEMENT_FAILURE, normalizeText, placementFailure } from "@fadenstack/client";
import { englishStrings, germanStrings } from "@fadenstack/ui";
import {
  hasReaderText,
  invisibleMark,
  invisibleRecordIds,
  isCode,
  isLabel,
  isOfficeAnchor,
  officeAnchorName,
  officeCustomXmlPart,
  officeDocumentPropertyValue,
  readOfficeCustomXmlPart,
  readerText,
  readerTextSha256,
  similarityClassifier,
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
