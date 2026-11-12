import type { MarkdownBlock } from "./markdown/model.js";
import { tableCellText } from "./markdown/serialize.js";

/** The byte order mark that tells Excel a CSV file is UTF-8, so umlauts and other letters open correctly. */
export const CSV_BOM = String.fromCharCode(0xfeff);

/** What starts a cell a spreadsheet would read as a formula: `=`, `+`, `-`, `@`, tab, carriage return and NUL. */
const FORMULA_START = /^[=+\-@\t\r\0]/;

/**
 * One CSV field: protected against formula injection, then quoted as RFC 4180 asks (a field with a comma, a double
 * quote, CR or LF is wrapped in double quotes and its quotes are doubled).
 *
 * OWASP ASVS 5.0 1.2.10: a cell whose first character is `=`, `+`, `-`, `@`, tab, carriage return or NUL gets a
 * leading single quote, so a spreadsheet shows it as text instead of running it. This also changes a plain negative
 * number such as `-5` to `'-5`: the standard lists `-`, and the file is for reading, not for calculating.
 */
export function csvField(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows of text as CSV (RFC 4180): fields as `csvField` writes them, CRLF between records, no mark. */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/**
 * A Markdown table as a CSV file's content: UTF-8 with a leading byte order mark, the header first, the cells' text
 * as the "Copy table" button takes it (no marks; the table block's cells, not the drawn HTML).
 */
export function tableToCsv(table: Extract<MarkdownBlock, { kind: "table" }>): string {
  return CSV_BOM + rowsToCsv([table.header, ...table.rows].map((row) => row.map(tableCellText))) + "\r\n";
}

/** The CSV file's name: `table.csv` for the first table of an answer, `table-2.csv` for the second. */
export function csvFileName(position: number): string {
  return position <= 1 ? "table.csv" : `table-${position}.csv`;
}
