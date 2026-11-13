import { describe, expect, it } from "vitest";

import { CSV_BOM, MarkdownPart, csvField, csvFileName, englishStrings, germanStrings, rowsToCsv, tableToCsv, tablesOf, type FileToSave, type PartContext } from "@fadenstack/ui";

const BOM = String.fromCharCode(0xfeff);

describe("csvField (RFC 4180)", () => {
  it("quotes a field with a comma, a double quote, CR or LF, and doubles the quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("two\r\nlines")).toBe('"two\r\nlines"');
    expect(csvField("")).toBe("");
  });

  it("puts CRLF between records and none after the last", () => {
    expect(rowsToCsv([["a", "b,c"], ["1", "2"]])).toBe('a,"b,c"\r\n1,2');
  });
});

describe("csvField formula protection (OWASP ASVS 5.0 1.2.10)", () => {
  it("prefixes a single quote when a cell starts with =, +, -, @, tab, CR or NUL", () => {
    expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1+1")).toBe("'-1+1");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("\rx")).toBe("\"'\rx\""); // the prefix first, then the quoting the CR needs
    expect(csvField("\0x")).toBe("'\0x");
  });

  it("also prefixes a plain negative number such as -5, because the standard lists the minus sign", () => {
    expect(csvField("-5")).toBe("'-5");
  });

  it("leaves a formula character inside the text alone, and prefixes before it quotes", () => {
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField('=HYPERLINK("http://x","y")')).toBe("\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
  });
});

describe("tableToCsv", () => {
  const table = tablesOf("| Name | Note |\n|---|---|\n| Müller | **bold**, with comma |\n| =cmd | line one two |")[0]!;

  it("starts with the byte order mark so Excel opens umlauts, then the header, with CRLF records", () => {
    const csv = tableToCsv(table);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(CSV_BOM).toBe(BOM);
    expect(csv.slice(1)).toBe('Name,Note\r\nMüller,"bold, with comma"\r\n\'=cmd,line one two\r\n');
  });

  it("names the files table.csv, table-2.csv, ...", () => {
    expect([1, 2, 3].map(csvFileName)).toEqual(["table.csv", "table-2.csv", "table-3.csv"]);
  });
});

function context(saveFile?: (file: FileToSave) => void | Promise<void>): PartContext {
  return { strings: englishStrings, clipboard: { setText: async () => undefined }, locale: "en", previewLength: 100, now: () => new Date(), ...(saveFile ? { saveFile } : {}) } as PartContext;
}

describe("a Markdown part's table download", () => {
  const text = "| A | B |\n|---|---|\n| 1 | 2 |\n\nAnd another:\n\n| C |\n|---|\n| -5 |";

  it("hands the host a UTF-8 CSV named table.csv, then table-2.csv for the second table", () => {
    const saved: FileToSave[] = [];
    const part = new MarkdownPart(context((f) => void saved.push(f)), text);
    const tables = part.blocks.filter((b) => b.kind === "table");
    part.downloadTableCsv(tables[0]!);
    part.downloadTableCsv(tables[1]!);
    expect(saved.map((f) => [f.name, f.type])).toEqual([["table.csv", "text/csv"], ["table-2.csv", "text/csv"]]);
    expect(saved[0]!.content).toBe(`${BOM}A,B\r\n1,2\r\n`);
    expect(saved[1]!.content).toBe(`${BOM}C\r\n'-5\r\n`);
  });

  it("survives a host whose saveFile fails", async () => {
    const part = new MarkdownPart(context(() => Promise.reject(new Error("no"))), text);
    expect(() => part.downloadTableCsv(part.blocks.find((b) => b.kind === "table")!)).not.toThrow();
    await Promise.resolve();
  });

  it("has a German label for the button", () => {
    expect(germanStrings.downloadCsv).toBe("CSV herunterladen");
  });
});
