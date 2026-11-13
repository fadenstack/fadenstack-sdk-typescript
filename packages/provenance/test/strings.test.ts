import { describe, expect, it, vi } from "vitest";

import { ProvenanceReader, builtInMarkStrings, markStringsFor } from "@fadenstack/provenance";

// The module owns the words its marks show (sdk/52 P1): the same words in all five languages as before they moved out
// of the UI package, the title is the label, a space and the record id, and the reader knows every language's title.

const ID = "0193b5d2-7c4e-7a10-8f00-000000000001";

describe("the mark texts", () => {
  it.each([
    ["en", "AI-generated"],
    ["de", "KI-generiert"],
    ["fr", "Généré par IA"],
    ["es", "Generado por IA"],
    ["zh-Hans", "人工智能生成"],
  ])("are the same words in %s", (tag, label) => {
    expect(builtInMarkStrings[tag]?.aiGenerated).toBe(label);
    expect(builtInMarkStrings[tag]?.aiGeneratedTitle(ID)).toBe(`${label} ${ID}`);
    expect(markStringsFor(tag).aiGenerated).toBe(label);
  });

  it("find a regional language's, a script's, and English when none fits", () => {
    expect(markStringsFor("de-AT").aiGenerated).toBe("KI-generiert");
    expect(markStringsFor("zh-CN").aiGenerated).toBe("人工智能生成");
    expect(markStringsFor("zh-TW").aiGenerated).toBe("AI-generated"); // Traditional is another script
    expect(markStringsFor(["ja", "fr-CA"]).aiGenerated).toBe("Généré par IA");
    expect(markStringsFor("not a language!").aiGenerated).toBe("AI-generated");
  });

  it("follow the host's languages without one given", () => {
    vi.stubGlobal("navigator", { languages: ["ja", "es-MX"], language: "ja" });
    try {
      expect(markStringsFor().aiGenerated).toBe("Generado por IA");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("are read back in every built-in language", () => {
    expect(Object.keys(builtInMarkStrings)).toEqual(["en", "de", "fr", "es", "zh-Hans"]);
    const reader = new ProvenanceReader();
    for (const strings of Object.values(builtInMarkStrings)) {
      expect(reader.fromHtml(`<span title="${strings.aiGeneratedTitle(ID)}">x</span>`)).toEqual([{ carrier: "html-title", recordId: ID }]);
    }
  });
});
