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
