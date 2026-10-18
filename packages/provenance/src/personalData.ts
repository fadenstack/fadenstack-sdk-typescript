import { RECORD_ID_IN_TEXT } from "./content.js";

/** Personal data found in text a mark carries. */
export interface PersonalDataFinding {
  readonly kind: "email" | "phone" | "iban" | "ip-address" | "known";
  readonly value: string;
}

const PATTERNS: { kind: PersonalDataFinding["kind"]; pattern: RegExp; valid?: (value: string) => boolean }[] = [
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { kind: "ip-address", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  // Seven digits or more, with the separators phone numbers are written with; not inside an id or a date.
  { kind: "phone", pattern: /(?<![\w.:-])\+?\d[\d ()/.-]{5,}\d(?![\w-])/g, valid: (v) => v.replace(/\D/g, "").length >= 7 },
];

/** Times (2026-10-18T09:30:00.000Z) and record ids look like numbers; they are not personal. */
const TIMES = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/**
 * Personal data in `text`: mail addresses, phone numbers, IBANs, IP addresses, and any of `known` (a user's name, a
 * prompt), case-insensitively. Record ids and times are left out first. For checking what marks carry: a mark holds
 * ids, kinds and times, never any of these.
 */
export function findPersonalData(text: string, known: readonly string[] = []): PersonalDataFinding[] {
  const found: PersonalDataFinding[] = [];
  const lower = text.toLowerCase();
  for (const value of known) {
    if (value.trim().length >= 3 && lower.includes(value.trim().toLowerCase())) found.push({ kind: "known", value });
  }
  let cleaned = text.replace(RECORD_ID_IN_TEXT, " ").replace(TIMES, " ");
  for (const { kind, pattern, valid } of PATTERNS) {
    for (const match of cleaned.matchAll(pattern)) {
      if (!valid || valid(match[0])) found.push({ kind, value: match[0] });
    }
    // What one pattern found is not found again by the next (an IBAN's digits are no phone number).
    cleaned = cleaned.replace(pattern, " ");
  }
  return found;
}
