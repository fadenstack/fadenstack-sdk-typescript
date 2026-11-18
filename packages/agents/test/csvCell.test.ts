import { describe, expect, it } from "vitest";

import { csvCell } from "@fadenstack/agents";

/**
 * The shared table of CSV cases: the same inputs and outputs are in the .NET tests (`AuditCsvCellTests`) and in the
 * table download of `@fadenstack/ui` (`csv.test.ts`). OWASP ASVS 5.0 1.2.10.
 */
const CASES: readonly (readonly [string, string])[] = [
  ["plain", "plain"],
  ["", ""],
  ["a=b", "a=b"],
  ["a,b", '"a,b"'],
  ["a;b", '"a;b"'],
  ["=cmd", "'=cmd"],
  ["a;=b", `"a;'=b"`],
  ["=1;=2", `"'=1;'=2"`],
  ["x,=y", `"x,'=y"`],
  ["x;-5", `"x;'-5"`],
  ["a;;@b", `"a;;'@b"`],
  ['say "hi"; ok', '"say ""hi""; ok"'],
  ['"a";=b', `"""a"";'=b"`],
  ["two\nlines", '"two\nlines"'],
];

describe("csvCell: the shared table of cases", () => {
  for (const [input, expected] of CASES) {
    it(`writes ${JSON.stringify(input)} as ${JSON.stringify(expected)}`, () => {
      expect(csvCell(input)).toBe(expected);
    });
  }
});
