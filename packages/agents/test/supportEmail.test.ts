import { describe, expect, it } from "vitest";

import { DEFAULT_SUPPORT_EMAIL, SUPPORT_EMAIL_MAX_LENGTH, isSupportEmail } from "@fadenstack/agents";

// "Report a problem" (0.3.1): the address must be one plain address, so a policy or an option cannot add a recipient, a bcc or a body
// to the draft (OWASP ASVS 5.0 V1). The same rule in the .NET SDK; the UI package tests it again with the sheet.
describe("isSupportEmail", () => {
  it("accepts one plain address and Fadenstack's own", () => {
    expect(isSupportEmail("a@b.example")).toBe(true);
    expect(isSupportEmail(DEFAULT_SUPPORT_EMAIL)).toBe(true);
  });

  it("refuses what could add a recipient, a bcc or a body to a draft", () => {
    for (const value of ["a@b.example?bcc=x@y.example", "a@b.example,c@d.example", "a b@c.example", "a@b.example\n", "a@b.example\r\nBcc: x@y.example", "100%@b.example"]) {
      expect(isSupportEmail(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("allows 254 characters and refuses 255", () => {
    const of = (length: number) => `${"a".repeat(length - 10)}@b.example`;
    expect(SUPPORT_EMAIL_MAX_LENGTH).toBe(254);
    expect(isSupportEmail(of(254))).toBe(true);
    expect(isSupportEmail(of(255))).toBe(false);
  });
});
