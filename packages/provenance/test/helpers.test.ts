import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PROVENANCE_POLICY } from "@fadenstack/client";
import { editSimilarity, findPersonalData, suggestEditKind, tightenPolicy } from "@fadenstack/provenance";

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
    const record = JSON.stringify({
      id: "3f2c8a8e-1234-4567-8901-234567890123", created_at: "2026-10-18T09:30:00.123Z",
      unsigned: "unsigned-12345678901234567890123456789012", v: 1,
    });
    expect(findPersonalData(record)).toEqual([]);
  });
});
