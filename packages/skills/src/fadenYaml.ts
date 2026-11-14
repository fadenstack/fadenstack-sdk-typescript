/** The YAML of a skill's `faden.yaml` is not accepted: it is too large, too deep, or uses something a skill may not use. */
export class FadenYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FadenYamlError";
  }
}

/**
 * What the reader gives back: null, a boolean, an integer (`bigint`, a 64-bit signed one as .NET's `long`), a string, an array
 * or a map (a repeated key: the last wins, as in PyYAML). A `Map`, so that a key such as `__proto__` is only a key.
 */
export type YamlValue = null | boolean | bigint | string | YamlValue[] | Map<string, YamlValue>;

export const MAX_YAML_BYTES = 32 * 1024;
export const MAX_YAML_DEPTH = 8;

const TRUE = new Set(["true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON"]);
const FALSE = new Set(["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"]);

const LONG_MAX = (1n << 63n) - 1n;

/**
 * Reads the YAML in `text`; throws `FadenYamlError` when it is not accepted.
 *
 * A small reader for `faden.yaml`, which comes from whoever wrote the skill (untrusted input). It holds the limits of core's
 * `skills/faden_skills/services/safe_yaml.py`: at most 32 KiB, nesting at most 8 levels (scalars count as a level, as the
 * parser's nodes do there), and no anchors (`&a`), aliases (`*a`) or tags (`!t`) -- without references a document cannot grow
 * past its own size. Beyond core it refuses what a skill never needs and a hand-written reader would get wrong: block scalars
 * (`|`, `>`), a second document, tabs in the indentation, multi-line plain or quoted scalars, complex keys, and control or
 * invisible characters. It reads block maps and lists, flow lists and maps, plain, single- and double-quoted scalars and
 * comments. Plain scalars resolve like PyYAML's safe loader does (YAML 1.1: `yes`/`no`/`on`/`off` are booleans, integers,
 * `null`/`~`), so a file reads to the same types here and in core; everything else is a string. .NET: `FadenYaml.Parse`.
 */
export function parseFadenYaml(text: string): YamlValue {
  if (new TextEncoder().encode(text).length > MAX_YAML_BYTES) throw new FadenYamlError("The YAML is larger than 32 KiB.");
  checkCharacters(text);
  return new Reader(lines(text)).document();
}

function deep(): FadenYamlError {
  return new FadenYamlError(`The YAML nests more than ${MAX_YAML_DEPTH} levels deep.`);
}

function checkCharacters(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const invisible = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x80 && c <= 0x9f)
      || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064)
      || (c >= 0x2066 && c <= 0x2069) || c === 0x00ad || (c === 0xfeff && i > 0);
    if (invisible) throw new FadenYamlError("The YAML holds a control or invisible character.");
  }
}

interface Line {
  indent: number;
  text: string;
}

function lines(text: string): Line[] {
  const result: Line[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (indent < raw.length && raw[indent] === "\t") throw new FadenYamlError("The YAML indents with a tab.");
    const content = stripComment(raw.slice(indent)).trimEnd();
    if (content.length > 0) result.push({ indent, text: content });
  }
  return result;
}

/** The text before a comment: a `#` at the start or after a space, outside quotes. */
function stripComment(text: string): string {
  let quote = "";
  let previous = ""; // the last character that is not a space
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== "") {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if ((c === '"' || c === "'") && (previous === "" || previous === ":" || previous === "-" || previous === "[" || previous === "," || previous === "{")) {
      quote = c;
    } else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i);
    }
    if (c !== " " && c !== "\t") previous = c;
  }
  return text;
}

function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

class Reader {
  readonly #lines: Line[];
  #pos = 0;

  constructor(lines: Line[]) {
    this.#lines = lines;
  }

  document(): YamlValue {
    if (this.#lines.length > 0 && this.#lines[0]!.text === "---") this.#pos = 1;
    if (this.#pos >= this.#lines.length) return null;
    for (let i = this.#pos; i < this.#lines.length; i++) {
      const line = this.#lines[i]!;
      if (line.indent === 0 && (line.text === "---" || line.text === "..." || line.text.startsWith("--- "))) {
        throw new FadenYamlError("The YAML holds more than one document.");
      }
    }
    const value = this.#block(this.#lines[this.#pos]!.indent, 1);
    if (this.#pos < this.#lines.length) throw new FadenYamlError("The YAML is not laid out as a map or a list.");
    return value;
  }

  #block(indent: number, depth: number): YamlValue {
    if (depth > MAX_YAML_DEPTH) throw deep();
    const line = this.#lines[this.#pos]!;
    if (isItem(line.text)) return this.#list(indent, depth);
    if (keyOf(line.text) !== null) return this.#map(indent, depth);
    // A lone scalar document.
    this.#pos++;
    const scalar = this.#inline(line.text, depth);
    if (this.#pos < this.#lines.length) throw new FadenYamlError("The YAML holds a scalar that goes over several lines.");
    return scalar;
  }

  #map(indent: number, depth: number): Map<string, YamlValue> {
    if (depth + 1 > MAX_YAML_DEPTH) throw deep(); // the keys are nodes too
    const map = new Map<string, YamlValue>();
    for (;;) {
      const line = this.#lines[this.#pos];
      if (!line || line.indent !== indent) break;
      const entry = keyOf(line.text);
      if (entry === null) break;
      this.#pos++;
      map.set(entry.name, entry.tail.length === 0 ? this.#nested(indent, depth) : this.#inline(entry.tail, depth + 1));
    }
    this.#finish(indent, true);
    return map;
  }

  /** The value on the lines after `key:`: a block indented further (or a list at the key's own indent), else null. */
  #nested(indent: number, depth: number): YamlValue {
    const next = this.#lines[this.#pos];
    if (next && (next.indent > indent || (next.indent === indent && isItem(next.text)))) return this.#block(next.indent, depth + 1);
    return null;
  }

  #list(indent: number, depth: number): YamlValue[] {
    const list: YamlValue[] = [];
    for (;;) {
      const line = this.#lines[this.#pos];
      if (!line || line.indent !== indent || !isItem(line.text)) break;
      const text = line.text;
      const rest = text.slice(1).trimStart();
      const inner = indent + (text.length - rest.length);
      if (rest.length === 0) {
        this.#pos++;
        list.push(this.#nested(indent, depth));
      } else if (isItem(rest) || keyOf(rest) !== null) {
        // "- key: value" or "- - x": the rest is the first line of a block that starts further in.
        this.#lines[this.#pos] = { indent: inner, text: rest };
        list.push(this.#block(inner, depth + 1));
      } else {
        this.#pos++;
        list.push(this.#inline(rest, depth + 1));
      }
    }
    this.#finish(indent, false);
    return list;
  }

  /** A block ends at a line that is less indented; a map also ends at a line of its own indent that is a key, and a list at one that is not an item (the map around it goes on). */
  #finish(indent: number, map: boolean): void {
    const line = this.#lines[this.#pos];
    if (line && (line.indent > indent || (map && line.indent === indent))) throw new FadenYamlError("The YAML is not laid out as a map or a list.");
  }

  /** The value written on a line after its key or list dash. */
  #inline(text: string, depth: number): YamlValue {
    if (depth > MAX_YAML_DEPTH) throw deep();
    if (text[0] === "[" || text[0] === "{") {
      let source = text;
      for (;;) {
        try {
          const flow = new Flow(source);
          const value = flow.value(depth);
          flow.end();
          return value;
        } catch (error) {
          if (!(error instanceof EndOfFlow)) throw error;
          if (this.#pos >= this.#lines.length) throw new FadenYamlError("A bracket in the YAML is not closed.");
          source += " " + this.#lines[this.#pos]!.text;
          this.#pos++;
        }
      }
    }
    if (text[0] === '"' || text[0] === "'") {
      const end = quoteEnd(text, 0);
      if (end < 0) throw new FadenYamlError("A quoted value in the YAML is not closed on its line.");
      if (text.slice(end + 1).trim().length > 0) throw new FadenYamlError("A quoted value in the YAML is followed by more text.");
      return quoted(text.slice(0, end + 1));
    }
    indicator(text);
    if (text.includes(": ") || text.endsWith(":")) throw new FadenYamlError("The YAML holds a map where a value is expected.");
    return plain(text);
  }
}

/** The key and the rest of a `key: rest` line; null when the line is not one (a flow value, a list item, a scalar). */
function keyOf(text: string): { name: string; tail: string } | null {
  if (text[0] === "[" || text[0] === "{" || isItem(text)) return null;
  let key: string;
  let after: number;
  if (text[0] === '"' || text[0] === "'") {
    const end = quoteEnd(text, 0);
    if (end < 0) return null;
    key = quoted(text.slice(0, end + 1));
    after = end + 1;
    while (after < text.length && text[after] === " ") after++;
    if (after >= text.length || text[after] !== ":" || (after + 1 < text.length && text[after + 1] !== " ")) return null;
  } else {
    after = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
        after = i;
        break;
      }
    }
    if (after <= 0) return null;
    const plainKey = text.slice(0, after).trimEnd();
    indicator(plainKey);
    key = plainKey;
  }
  return { name: key, tail: text.slice(after + 1).trim() };
}

/** The characters a plain scalar may not start with, each with the reason. */
function indicator(text: string): void {
  switch (text[0]) {
    case "&":
      throw new FadenYamlError("YAML anchors (&name) are not allowed.");
    case "*":
      throw new FadenYamlError("YAML aliases (*name) are not allowed.");
    case "!":
      throw new FadenYamlError("YAML tags (!tag) are not allowed.");
    case "|":
    case ">":
      throw new FadenYamlError("YAML block scalars (| and >) are not read; write the value on one line.");
    case "?":
      if (text.length === 1 || text[1] === " ") throw new FadenYamlError("YAML complex keys are not allowed.");
      break;
    case "%":
    case "@":
    case "`":
      throw new FadenYamlError("The YAML holds a character that may not start a value.");
  }
}

/** The index of the quote that closes the one at `start`; -1 when there is none. */
function quoteEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
    } else if (text[i] === quote) {
      if (quote === "'" && i + 1 < text.length && text[i + 1] === "'") {
        i++; // '' is a quote in a single-quoted scalar
        continue;
      }
      return i;
    }
  }
  return -1;
}

function quoted(token: string): string {
  const inner = token.slice(1, -1);
  if (token[0] === "'") return inner.replaceAll("''", "'");
  let result = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      result += c;
      continue;
    }
    i++;
    if (i >= inner.length) throw new FadenYamlError("A quoted value in the YAML ends in a backslash.");
    const e = inner[i]!;
    switch (e) {
      case "n": result += "\n"; break;
      case "t": result += "\t"; break;
      case "r": result += "\r"; break;
      case "0": result += "\0"; break;
      case '"': result += '"'; break;
      case "\\": result += "\\"; break;
      case "/": result += "/"; break;
      case " ": result += " "; break;
      case "x":
      case "u": {
        const digits = e === "x" ? 2 : 4;
        const decoded = hexEscape(inner, i, digits);
        if (decoded === null) throw new FadenYamlError("A quoted value in the YAML holds an escape that is not read.");
        result += decoded;
        i += digits;
        break;
      }
      default:
        throw new FadenYamlError("A quoted value in the YAML holds an escape that is not read.");
    }
  }
  checkCharacters(result);
  return result;
}

/** The character `digits` hex digits after the `x` or `u` at `index` stand for; null when they are not there or not hex. */
function hexEscape(text: string, index: number, digits: number): string | null {
  if (index + digits >= text.length) return null;
  const hex = text.slice(index + 1, index + 1 + digits);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return String.fromCharCode(parseInt(hex, 16));
}

/** A plain scalar as PyYAML's safe loader resolves it (YAML 1.1): null, a boolean, an integer, else the text. */
function plain(text: string): YamlValue {
  if (text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  const number = integer(text);
  return number !== null ? number : text;
}

function integer(text: string): bigint | null {
  const s = text.replaceAll("_", "");
  if (s.length === 0 || text[0] === "_" || text[text.length - 1] === "_") return null;
  const negative = s[0] === "-";
  const digits = s[0] === "-" || s[0] === "+" ? s.slice(1) : s;
  if (digits.length === 0) return null;
  let value: bigint;
  if (digits.length > 2 && digits[0] === "0" && (digits[1] === "x" || digits[1] === "X")) {
    const hex = digits.slice(2);
    // .NET's hexadecimal parse of a long: up to 16 digits, the top bit is the sign.
    if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
    value = BigInt.asIntN(64, BigInt("0x" + hex));
  } else if (digits.length > 1 && digits[0] === "0") {
    // Octal, as YAML 1.1 reads a leading zero; 09 is not a number there.
    value = 0n;
    for (const c of digits) {
      if (c < "0" || c > "7" || value > LONG_MAX / 8n - 1n) return null;
      value = value * 8n + BigInt(c.charCodeAt(0) - 48);
    }
  } else {
    if (!/^[0-9]+$/.test(digits)) return null;
    value = BigInt(digits);
    if (value > LONG_MAX) return null;
  }
  return negative ? -value : value;
}

/** A flow value ran into the end of its text: it may go on in the next line. */
class EndOfFlow extends Error {}

/** A flow collection (`[a, b]`, `{k: v}`) in one string. */
class Flow {
  readonly #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  end(): void {
    this.#space();
    if (this.#at < this.#text.length) throw new FadenYamlError("A flow value in the YAML is followed by more text.");
  }

  #space(): void {
    while (this.#at < this.#text.length && (this.#text[this.#at] === " " || this.#text[this.#at] === "\t")) this.#at++;
  }

  value(depth: number): YamlValue {
    if (depth > MAX_YAML_DEPTH) throw deep();
    this.#space();
    if (this.#at >= this.#text.length) throw new EndOfFlow();
    const c = this.#text[this.#at]!;
    if (c === "[") {
      this.#at++;
      const list: YamlValue[] = [];
      for (;;) {
        this.#space();
        if (this.#at >= this.#text.length) throw new EndOfFlow();
        if (this.#text[this.#at] === "]") {
          this.#at++;
          return list;
        }
        list.push(this.value(depth + 1));
        this.#separator("]");
      }
    }
    if (c === "{") {
      this.#at++;
      const map = new Map<string, YamlValue>();
      for (;;) {
        this.#space();
        if (this.#at >= this.#text.length) throw new EndOfFlow();
        if (this.#text[this.#at] === "}") {
          this.#at++;
          return map;
        }
        const key = this.value(depth + 1);
        if (typeof key !== "string") throw new FadenYamlError("A key in a flow map of the YAML is not text.");
        this.#space();
        if (this.#at < this.#text.length && this.#text[this.#at] === ":") {
          this.#at++;
          map.set(key, this.value(depth + 1));
        } else {
          map.set(key, null);
        }
        this.#separator("}");
      }
    }
    if (c === '"' || c === "'") {
      const end = quoteEnd(this.#text, this.#at);
      if (end < 0) throw new EndOfFlow();
      const token = this.#text.slice(this.#at, end + 1);
      this.#at = end + 1;
      return quoted(token);
    }
    const start = this.#at;
    while (this.#at < this.#text.length && this.#text[this.#at] !== "," && this.#text[this.#at] !== "]" && this.#text[this.#at] !== "}"
      && !(this.#text[this.#at] === ":" && (this.#at + 1 === this.#text.length || this.#text[this.#at + 1] === " " || this.#text[this.#at + 1] === ","
        || this.#text[this.#at + 1] === "]" || this.#text[this.#at + 1] === "}"))) {
      this.#at++;
    }
    const scalar = this.#text.slice(start, this.#at).trim();
    if (scalar.length === 0) return null;
    indicator(scalar);
    return plain(scalar);
  }

  #separator(close: string): void {
    this.#space();
    if (this.#at >= this.#text.length) throw new EndOfFlow();
    if (this.#text[this.#at] === ",") this.#at++;
    else if (this.#text[this.#at] !== close) throw new FadenYamlError("A flow value in the YAML is not laid out as a list or a map.");
  }
}
