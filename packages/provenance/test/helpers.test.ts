import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PROVENANCE_POLICY } from "@fadenstack/client";
import { editSimilarity, findPersonalData, similarityClassifier, suggestEditKind, tightenPolicy } from "@fadenstack/provenance";

const policy = { ...DEFAULT_PROVENANCE_POLICY, exempt_edit_kinds: [...DEFAULT_PROVENANCE_POLICY.exempt_edit_kinds] };

describe("the edit-kind helper", () => {
  const original = "Thank you for your message. The delivery for order 4711 arrives on Friday, and the missing part comes with it.";

  it("suggests corrected for spelling and light polish", () => {
    expect(suggestEditKind("Thank you for you message. The delivery arive on Friday.", "Thank you for your message. The delivery arrives on Friday."))
      .toBe("corrected");
    expect(suggestEditKind(original, original.replace("arrives on Friday", "arrives on Friday morning"))).toBe("corrected");
  });

  it("stays at rewritten for anything more", () => {
    expect(suggestEditKind(original, "Your order 4711 ships Friday. The missing part is included.")).toBe("rewritten");
    expect(suggestEditKind(original, `${original} We are sorry for the delay.`)).toBe("rewritten"); // a sentence more
    expect(suggestEditKind(original, "")).toBe("rewritten");
  });

  it("measures word similarity, ignoring case, punctuation and white space", () => {
    expect(editSimilarity("Hello,  World!", "hello world")).toBe(1);
    expect(editSimilarity("a b c d", "a x c d")).toBe(0.75);
    expect(editSimilarity("", "")).toBe(1);
    expect(editSimilarity("会议在周五", "会议在周一")).toBe(0.8); // each CJK character a word
  });

  it("gives the reason the .NET SDK gives", () => {
    const classify = similarityClassifier().classify;
    const corrected = "Thank you for your message. The delivery arrives on Friday.";
    expect(classify({ tool: "t", declared: "rewritten", mediaType: "text/plain", content: corrected, original: "Thank you for you message. The delivery arive on Friday." }))
      .toEqual({ kind: "corrected", reason: "small change: 95 % of words kept, the same 2 sentence(s)" });
    expect(classify({ tool: "t", declared: "corrected", mediaType: "text/plain", content: "Ships Friday.", original: corrected }))
      .toEqual({ kind: "rewritten", reason: expect.stringMatching(/^\d+ % of words kept, 2 to 1 sentence\(s\)$/) });
  });

  it("compares HTML and Markdown by the text a reader sees: an editor's markup is no rewrite (the .NET SDK says the same)", () => {
    const before = "<p>Teh report is due on friday.</p>";
    const after = '<p class="MsoNormal" style="margin:0"><span lang="de">The report is due on Friday.</span></p>';
    expect(suggestEditKind(before, after, { mediaType: "text/html" })).toBe("corrected");
    expect(suggestEditKind(before, after)).toBe("rewritten"); // as plain text, the tags are words
    const classify = similarityClassifier().classify;
    expect(classify({ tool: "t", declared: "rewritten", mediaType: "text/html; charset=utf-8", content: after, original: before }))
      .toEqual({ kind: "corrected", reason: "small change: 89 % of words kept, the same 1 sentence(s)" });
    expect(classify({ tool: "t", declared: "rewritten", mediaType: "text/markdown", content: "The report is due on **Friday**.", original: "**Teh** report is due on *friday*." }))
      .toEqual({ kind: "corrected", reason: "small change: 89 % of words kept, the same 1 sentence(s)" });
  });
});

describe("the edit-kind helper judges only what changed (edit-kind-vectors.json has more, for both SDKs)", () => {
  const kept = [
    "Pump P-200 on line 3 was inspected on Monday after the operators reported water under the housing.",
    "The technician will replace the seal MS-40 on Thursday morning, and line 3 runs on the standby pump in that time.",
    "The worn seal goes to the manufacturer for analysis, so that the next inspection can look for the same wear.",
    "If the leak gets worse before the visit, switch the pump off and call the service desk on the number in the contract.",
  ];
  const last = "Please let us know if Thursday does not suit you. We can arrange another visit within the week.";
  const note = (...paragraphs: string[]) => paragraphs.join("\n\n");

  it("a paragraph rewritten in an unchanged text is rewritten, though the whole kept most of its words and sentences", () => {
    const original = note(...kept, last);
    const revised = note(...kept, "If Thursday does not suit you, just tell us. We are glad to arrange another visit this week.");
    expect(editSimilarity(original, revised)).toBeGreaterThan(0.85); // as a whole, a small change
    expect(similarityClassifier().classify({ tool: "t", declared: "rewritten", mediaType: "text/plain", content: revised, original }))
      .toEqual({ kind: "rewritten", reason: "38 % of words kept in the changed sentences (18 of 99 words), 2 to 2 sentence(s)" });
  });

  it("a typo fixed or a word swapped is corrected; a paragraph added, or a sentence split in two, is rewritten", () => {
    const original = note(...kept, last);
    expect(suggestEditKind(original.replace("inspected", "inspectd"), original)).toBe("corrected");
    expect(suggestEditKind(original, original.replace("call the service desk", "phone the service desk"))).toBe("corrected");
    expect(suggestEditKind(note(...kept), original)).toBe("rewritten");
    expect(suggestEditKind(original, original.replace("morning, and line 3", "morning. Line 3"))).toBe("rewritten");
  });

  it("edits in several places are each judged on their own: unchanged sentences between them do not hide a rewrite", () => {
    const original = note(...kept, last.replace("within", "whithin"));
    const typos = note(...kept, last);
    expect(similarityClassifier().classify({ tool: "t", declared: "rewritten", mediaType: "text/plain", content: typos, original: original.replace("inspected", "inspectd") }))
      .toEqual({ kind: "corrected", reason: "small change in 2 places: 99 % of words kept in the changed sentences (25 of 99 words), the same 2 sentence(s)" });
    const rewrite = typos.replace(kept[0]!, "On Monday our team looked at pump P-200, because water had collected under it.");
    expect(editSimilarity(original, rewrite)).toBeGreaterThan(0.85); // as a whole, a small change
    expect(similarityClassifier().classify({ tool: "t", declared: "rewritten", mediaType: "text/plain", content: rewrite, original }))
      .toEqual({ kind: "rewritten", reason: "16 % of words kept in the changed sentences (place 1 of 2: 17 of 99 words), 1 to 1 sentence(s)" });
  });

  it("the same words throughout are compared as a whole, as before", () => {
    const text = note(...kept);
    expect(similarityClassifier().classify({ tool: "t", declared: "rewritten", mediaType: "text/html", content: `<p>${text.replace("MS-40", "<b>MS-40</b>")}</p>`, original: text }))
      .toEqual({ kind: "corrected", reason: "small change: 100 % of words kept, the same 4 sentence(s)" });
    expect(suggestEditKind(text, text.replace("Monday after", "Monday. After"))).toBe("rewritten"); // the same words, a sentence more
  });
});

describe("tightenPolicy", () => {
  it("takes what is stricter and ignores what is looser, saying so", () => {
    const ignored = vi.fn();
    const tightened = tightenPolicy(policy, { on_missing: "refuse", short_text_tokens: 50, exempt_edit_kinds: ["translated"], visible_label: true }, ignored);
    expect(tightened).toMatchObject({ on_missing: "refuse", short_text_tokens: 50, exempt_edit_kinds: ["translated"], visible_label: true });
    expect(ignored).not.toHaveBeenCalled();
    const strict = { ...policy, on_missing: "refuse" as const, short_text_tokens: 100, exempt_edit_kinds: ["translated" as const], output_log: true };
    const looser = {
      on_missing: "record" as const, short_text_tokens: 300, exempt_edit_kinds: ["translated" as const, "corrected" as const],
      internal_technical: true, output_log: false,
    };
    const kept = tightenPolicy(strict, looser, ignored);
    expect(kept).toEqual(strict);
    expect(ignored).toHaveBeenCalledTimes(5);
  });
});

describe("findPersonalData", () => {
  it("finds addresses, numbers and known values, never ids or times", () => {
    const kinds = findPersonalData("Mail erika@example.com, call +49 30 1234567, pay DE89 3704 0044 0532 0130 00 from 10.0.0.12.", ["Erika"])
      .map((f) => f.kind).sort();
    expect(kinds).toEqual(["email", "iban", "ip-address", "known", "phone"]);
    const record = JSON.stringify({ id: "3f2c8a8e-1234-4567-8901-234567890123", created_at: "2026-10-18T09:30:00.123Z", v: 1 });
    expect(findPersonalData(record)).toEqual([]);
  });
});
