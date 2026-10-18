import { describe, expect, it } from "vitest";

import { englishStrings, germanStrings } from "@fadenstack/ui";
import {
  invisibleMark,
  invisibleRecordIds,
  isCode,
  isLabel,
  isOfficeAnchor,
  officeAnchorName,
  officeCustomXmlPart,
  officeDocumentPropertyValue,
  readOfficeCustomXmlPart,
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

  it("HTML: one element with data-ai-generated and the title, the label and the id", () => {
    expect(wrapHtml("Hello", ID, englishStrings.aiGeneratedTitle(ID)))
      .toBe(`<span data-ai-generated="${ID}" title="AI-generated ${ID}">Hello</span>`);
    expect(wrapHtml("<p>Hallo</p>", ID, germanStrings.aiGeneratedTitle(ID)))
      .toBe(`<div data-ai-generated="${ID}" title="KI-generiert ${ID}"><p>Hallo</p></div>`);
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
});
