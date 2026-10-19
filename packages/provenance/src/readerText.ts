import { normalizeText, textSha256 } from "@fadenstack/client";

import { bareType } from "./content.js";

/**
 * The text a reader sees of HTML and Markdown -- what someone copies out of the editor, the mail or the rendered
 * page -- so a record of markup is found by the words people copy (`RecordRequest.text_sha256`) and an edit is judged
 * by its words, not its tags. Both SDKs extract it the same way; `reader-text-vectors.json` is the test.
 *
 * HTML: comments and the contents of `script`, `style`, `template`, `head` and `title` go; block elements (`p`, `div`,
 * `br`, `li`, headings, table rows and cells, ...) become line breaks; every other tag goes without a trace; entities
 * are decoded (HTML 4's named entities and `&apos;`, decimal and hex references; an unknown one stays as it is).
 *
 * Markdown, as a renderer shows it: front matter goes; fenced code keeps its lines and loses its fences; heading,
 * emphasis (`*`, `_`, `~`, matched as pairs), list, task and quote markers go; inline code keeps its text; a link
 * keeps its text and an image its alt text; reference definitions, thematic breaks and table delimiter rows go, table
 * cells are separated by white space; backslash escapes are resolved; HTML inside is read as HTML is. Lines are read one
 * by one: emphasis across a line break, indented code and HTML blocks are read as plain lines.
 */

/** A byte order mark, which no reader sees at the start of a text. */
const BOM = String.fromCharCode(0xfeff);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

/** Whether content of this media type has a reader's text other than itself: HTML, XHTML and Markdown. */
export function hasReaderText(mediaType: string): boolean {
  const type = bareType(mediaType);
  return HTML_TYPES.has(type) || MARKDOWN_TYPES.has(type);
}

/** The text a reader sees of `text`: of HTML and Markdown as `htmlText` and `markdownText` read it, anything else as it is. */
export function readerText(text: string, mediaType: string): string {
  const type = bareType(mediaType);
  return HTML_TYPES.has(type) ? htmlText(text) : MARKDOWN_TYPES.has(type) ? markdownText(text) : text;
}

/**
 * For HTML and Markdown: SHA-256 of the text a reader sees, normalised as content is hashed (`textSha256`), hex --
 * the record request's `text_sha256`. Undefined for any other media type, and for markup with no text to read.
 */
export async function readerTextSha256(text: string, mediaType: string): Promise<string | undefined> {
  if (!hasReaderText(mediaType)) return undefined;
  const plain = normalizeText(readerText(text, mediaType));
  return plain ? textSha256(plain) : undefined;
}

// -- HTML -------------------------------------------------------------------------------------------

/** Elements whose content no reader sees. */
const DROPPED = new Set(["script", "style", "template", "head", "title"]);

/** Elements that start a line of their own. */
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "html", "legend", "li", "main", "menu", "nav", "ol", "option", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);

/** The plain text of HTML: what a reader sees, with a line break for each block element (see the module's notes). */
export function htmlText(html: string): string {
  return textOfHtml(html.startsWith(BOM) ? html.slice(1) : html);
}

function textOfHtml(html: string): string {
  const n = html.length;
  let out = "";
  let text = 0; // where the text not yet written starts
  const flush = (end: number) => {
    if (end > text) out += decodeHtmlEntities(html.slice(text, end));
  };
  let i = 0;
  while ((i = html.indexOf("<", i)) >= 0) {
    if (html.startsWith("<!--", i)) {
      flush(i);
      const close = html.indexOf("-->", i + 4);
      i = text = close < 0 ? n : close + 3;
      continue;
    }
    const next = html.charCodeAt(i + 1);
    if (next === 0x21 || next === 0x3f) {
      // <!DOCTYPE ...>, <![CDATA[...]]>, <?xml ...?>: to the next ">"
      const close = html.indexOf(">", i + 2);
      if (close < 0) {
        i++;
        continue;
      }
      flush(i);
      i = text = close + 1;
      continue;
    }
    const end = next === 0x2f;
    const nameAt = end ? i + 2 : i + 1;
    if (!isAsciiLetter(html.charCodeAt(nameAt))) {
      i++; // a "<" in the text
      continue;
    }
    let j = nameAt;
    while (j < n && !endsTagName(html.charCodeAt(j))) j++;
    const close = tagEnd(html, j);
    if (close < 0) {
      i++; // never closed: text
      continue;
    }
    flush(i);
    const name = asciiLower(html.slice(nameAt, j));
    i = text = close;
    if (!end && DROPPED.has(name) && html.charCodeAt(close - 2) !== 0x2f) {
      i = text = afterEndTag(html, name, close);
    } else if (BLOCKS.has(name)) {
      out += "\n";
    }
  }
  flush(n);
  return out;
}

/** A tag name in lower case: ASCII letters only, so both SDKs agree on every name. */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** HTML's white space: tab, line feed, form feed, carriage return, space. */
function isHtmlSpace(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function endsTagName(c: number): boolean {
  return isHtmlSpace(c) || c === 0x2f || c === 0x3e;
}

/** Just after the `>` of a tag whose attributes start at `from` (a `>` in a quoted value does not end it); -1 for none. */
function tagEnd(html: string, from: number): number {
  let quote = 0;
  let equals = false;
  for (let k = from; k < html.length; k++) {
    const c = html.charCodeAt(k);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 0x3e) {
      return k + 1;
    } else if (c === 0x3d) {
      equals = true;
    } else if (equals && (c === 0x22 || c === 0x27)) {
      quote = c;
      equals = false;
    } else if (!isHtmlSpace(c)) {
      equals = false;
    }
  }
  return -1;
}

/** Just after the end tag `</name ...>` from `from` on, ignoring ASCII case; the text's end when there is none. */
function afterEndTag(html: string, name: string, from: number): number {
  for (let k = html.indexOf("</", from); k >= 0; k = html.indexOf("</", k + 2)) {
    const at = k + 2 + name.length;
    if (asciiLower(html.slice(k + 2, at)) === name && (at >= html.length || endsTagName(html.charCodeAt(at)))) {
      const gt = html.indexOf(">", at);
      return gt < 0 ? html.length : gt + 1;
    }
  }
  return html.length;
}

/** HTML 4's named entities and `apos`, by name and code point; the .NET SDK has the same table. */
const ENTITY_TABLE =
  "quot 34 amp 38 apos 39 lt 60 gt 62 nbsp 160 iexcl 161 cent 162 pound 163 curren 164 yen 165 brvbar 166 sect 167 uml 168 "
  + "copy 169 ordf 170 laquo 171 not 172 shy 173 reg 174 macr 175 deg 176 plusmn 177 sup2 178 sup3 179 acute 180 micro 181 "
  + "para 182 middot 183 cedil 184 sup1 185 ordm 186 raquo 187 frac14 188 frac12 189 frac34 190 iquest 191 Agrave 192 "
  + "Aacute 193 Acirc 194 Atilde 195 Auml 196 Aring 197 AElig 198 Ccedil 199 Egrave 200 Eacute 201 Ecirc 202 Euml 203 "
  + "Igrave 204 Iacute 205 Icirc 206 Iuml 207 ETH 208 Ntilde 209 Ograve 210 Oacute 211 Ocirc 212 Otilde 213 Ouml 214 "
  + "times 215 Oslash 216 Ugrave 217 Uacute 218 Ucirc 219 Uuml 220 Yacute 221 THORN 222 szlig 223 agrave 224 aacute 225 "
  + "acirc 226 atilde 227 auml 228 aring 229 aelig 230 ccedil 231 egrave 232 eacute 233 ecirc 234 euml 235 igrave 236 "
  + "iacute 237 icirc 238 iuml 239 eth 240 ntilde 241 ograve 242 oacute 243 ocirc 244 otilde 245 ouml 246 divide 247 "
  + "oslash 248 ugrave 249 uacute 250 ucirc 251 uuml 252 yacute 253 thorn 254 yuml 255 OElig 338 oelig 339 Scaron 352 "
  + "scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 Alpha 913 Beta 914 Gamma 915 Delta 916 Epsilon 917 Zeta 918 Eta 919 "
  + "Theta 920 Iota 921 Kappa 922 Lambda 923 Mu 924 Nu 925 Xi 926 Omicron 927 Pi 928 Rho 929 Sigma 931 Tau 932 Upsilon 933 "
  + "Phi 934 Chi 935 Psi 936 Omega 937 alpha 945 beta 946 gamma 947 delta 948 epsilon 949 zeta 950 eta 951 theta 952 "
  + "iota 953 kappa 954 lambda 955 mu 956 nu 957 xi 958 omicron 959 pi 960 rho 961 sigmaf 962 sigma 963 tau 964 "
  + "upsilon 965 phi 966 chi 967 psi 968 omega 969 thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201 "
  + "zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 "
  + "bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 "
  + "oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593 "
  + "rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706 "
  + "exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 "
  + "prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 "
  + "ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 "
  + "sdot 8901 lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 9001 rang 9002 loz 9674 spades 9824 clubs 9827 "
  + "hearts 9829 diams 9830";

let entityMap: Map<string, string> | undefined;

function namedEntities(): Map<string, string> {
  if (!entityMap) {
    const parts = ENTITY_TABLE.split(" ");
    entityMap = new Map();
    for (let k = 0; k < parts.length; k += 2) entityMap.set(parts[k]!, String.fromCodePoint(Number(parts[k + 1])));
  }
  return entityMap;
}

const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g;

/**
 * Text with its character references decoded: the named ones of HTML 4 (and `&apos;`, case as written), decimal and
 * hex ones up to U+10FFFF but surrogates and U+0000. Anything else stays as it is.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return namedEntities().get(name) ?? whole;
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

// -- Markdown ---------------------------------------------------------------------------------------

const LINE_BREAK = /\r\n|\r|\n/;
const BLANK = /^[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const FENCE = /^[ \t]*(`{3,}|~{3,})([\s\S]*)$/;
const DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*[^ \t]+(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}=+[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const HEADING_CLOSE = /(?:^|[ \t]+)#+[ \t]*$/;
const BULLET = /^[ \t]*[-*+](?:[ \t]+|$)/;
const ORDERED = /^[ \t]*([0-9]{1,9})[.)](?:[ \t]+|$)/;
const TASK = /^\[[ xX]\](?:[ \t]+|$)/;
const INDENTED = /^[ \t]/;

type LineKind = "text" | "code" | "drop" | "row";
/** What the line before was, for the rules that depend on it (an underline, an ordered list after a paragraph). */
type LineState = "start" | "blank" | "paragraph" | "list" | "other";

/** A piece of the text: markup is read as HTML afterwards, a literal (code, an escaped character) stays as it is. */
interface Segment {
  literal: boolean;
  text: string;
}

const NEWLINE: Segment = { literal: false, text: "\n" };
const CELL: Segment = { literal: false, text: "\t" };

/** The plain text of Markdown, as a renderer shows it (see the module's notes). */
export function markdownText(markdown: string): string {
  let lines = (markdown.startsWith(BOM) ? markdown.slice(1) : markdown).split(LINE_BREAK);
  if (lines[0] === "---") {
    const close = lines.findIndex((line, k) => k > 0 && (line === "---" || line === "..."));
    if (close > 0) lines = lines.slice(close + 1);
  }
  const kinds: LineKind[] = lines.map(() => "text");
  const bodies: string[] = [];
  const definitions = new Set<string>();

  // Quotes, fenced code and reference definitions.
  let fence: { char: string; length: number; depth: number } | undefined;
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k]!;
    if (fence) {
      for (let d = 0, q = QUOTE.exec(line); d < fence.depth && q; d++, q = QUOTE.exec(line)) line = line.slice(q[0].length);
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && BLANK.test(close[2]!)) {
        kinds[k] = "drop";
        fence = undefined;
      } else {
        kinds[k] = "code";
      }
      bodies.push(line);
      continue;
    }
    let depth = 0;
    for (let q = QUOTE.exec(line); q; q = QUOTE.exec(line)) {
      line = line.slice(q[0].length);
      depth++;
    }
    bodies.push(line);
    const open = FENCE.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      kinds[k] = "drop";
      fence = { char: open[1]![0]!, length: open[1]!.length, depth };
      continue;
    }
    const definition = DEFINITION.exec(line);
    if (definition) {
      kinds[k] = "drop";
      definitions.add(labelOf(definition[1]!));
    }
  }

  // Tables: a header row, a delimiter row, and the rows after it.
  for (let k = 1; k < lines.length; k++) {
    if (kinds[k] !== "text" || kinds[k - 1] !== "text") continue;
    if (!DELIMITER_ROW.test(bodies[k]!) || !bodies[k]!.includes("|") || !hasPipe(bodies[k - 1]!)) continue;
    kinds[k - 1] = "row";
    kinds[k] = "drop";
    for (let r = k + 1; r < lines.length && kinds[r] === "text" && !BLANK.test(bodies[r]!) && hasPipe(bodies[r]!); r++) kinds[r] = "row";
  }

  const segments: Segment[] = [];
  let previous: LineState = "start";
  for (let k = 0; k < lines.length; k++) {
    let body = bodies[k]!;
    switch (kinds[k]) {
      case "code":
        segments.push({ literal: true, text: body }, NEWLINE);
        previous = "other";
        continue;
      case "drop":
        previous = "other";
        continue;
      case "row":
        for (const cell of tableCells(body)) {
          inline(cell, definitions, segments);
          segments.push(CELL);
        }
        segments.push(NEWLINE);
        previous = "other";
        continue;
    }
    if (BLANK.test(body)) {
      segments.push(NEWLINE);
      previous = "blank";
      continue;
    }
    if (THEMATIC_BREAK.test(body) || (SETEXT_UNDERLINE.test(body) && previous === "paragraph")) {
      previous = "other";
      continue;
    }
    let now: LineState = previous === "list" && INDENTED.test(body) ? "list" : "paragraph";
    const heading = HEADING.exec(body);
    if (heading) {
      body = body.slice(heading[0].length).replace(HEADING_CLOSE, "");
      now = "other";
    } else {
      const bullet = BULLET.exec(body);
      const ordered = bullet ? null : ORDERED.exec(body);
      const marker = bullet ?? (ordered && (Number(ordered[1]) === 1 || previous !== "paragraph") ? ordered : null);
      if (marker) {
        body = body.slice(marker[0].length);
        const task = TASK.exec(body);
        if (task) body = body.slice(task[0].length);
        now = "list";
      }
    }
    inline(body, definitions, segments);
    segments.push(NEWLINE);
    previous = now;
  }

  let out = "";
  let markup = "";
  for (const segment of segments) {
    if (segment.literal) {
      out += textOfHtml(markup) + segment.text;
      markup = "";
    } else {
      markup += segment.text;
    }
  }
  return out + textOfHtml(markup);
}

/** A reference label as definitions and references are matched: white space runs one space, trimmed, in lower case. */
function labelOf(label: string): string {
  return label.replace(/[ \t]+/g, " ").replace(/^ | $/g, "").toLowerCase();
}

/** Whether a line has a `|` that is not escaped. */
function hasPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) if (line[i] === "|" && (i === 0 || line[i - 1] !== "\\")) return true;
  return false;
}

/**
 * A table row's cells, as GFM splits them: the outer pipes go, every other `|` that is not escaped separates two cells
 * (inside code too), and `\|` is a `|` in its cell.
 */
function tableCells(row: string): string[] {
  let s = row.replace(/^[ \t]+|[ \t]+$/g, "");
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += s[i];
    }
  }
  cells.push(cell);
  return cells;
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "literal"; text: string }
  | { kind: "delimiter"; char: string; length: number; open: boolean; close: boolean; matched: boolean };

const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCTUATION = /\p{P}/u;
const SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*)>/y;
const EMAIL_AUTOLINK = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

function isPunctuation(c: string): boolean {
  return ASCII_PUNCTUATION.includes(c) || PUNCTUATION.test(c);
}

/** White space as hashing counts it. */
function isSpace(c: string): boolean {
  return SPACES.has(c.charCodeAt(0));
}

/** One line's inline Markdown, as segments: emphasis that pairs goes, code and escapes stay as they are. */
function inline(line: string, definitions: ReadonlySet<string>, segments: Segment[]): void {
  const tokens = tokenize(line, definitions);
  // Emphasis: a closing run takes the nearest opening run of its character; runs that pair go, the others stay text.
  const openers: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "delimiter") continue;
    if (t.close) {
      let m = openers.length - 1;
      while (m >= 0 && (tokens[openers[m]!] as { char: string }).char !== t.char) m--;
      if (m >= 0) {
        (tokens[openers[m]!] as { matched: boolean }).matched = true;
        t.matched = true;
        openers.length = m;
        continue;
      }
    }
    if (t.open) openers.push(k);
  }
  for (const t of tokens) {
    if (t.kind === "literal") segments.push({ literal: true, text: t.text });
    else if (t.kind === "text") segments.push({ literal: false, text: t.text });
    else if (!t.matched) segments.push({ literal: false, text: t.char.repeat(t.length) });
  }
}

function tokenize(s: string, definitions: ReadonlySet<string>): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const push = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && ASCII_PUNCTUATION.includes(s[i + 1]!)) {
      push();
      tokens.push({ kind: "literal", text: s[i + 1]! });
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = runOf(s, i, "`");
      const close = backticks(s, i + run, run);
      if (close < 0) {
        text += s.slice(i, i + run);
        i += run;
        continue;
      }
      let code = s.slice(i + run, close);
      if (code.length >= 2 && code[0] === " " && code[code.length - 1] === " " && !/^ +$/.test(code)) code = code.slice(1, -1);
      push();
      tokens.push({ kind: "literal", text: code });
      i = close + run;
      continue;
    }
    if (c === "<") {
      AUTOLINK.lastIndex = i;
      EMAIL_AUTOLINK.lastIndex = i;
      const link = AUTOLINK.exec(s) ?? EMAIL_AUTOLINK.exec(s);
      if (link) {
        push();
        tokens.push({ kind: "literal", text: link[1]! });
        i += link[0].length;
        continue;
      }
    }
    const image = c === "!" && s[i + 1] === "[";
    if (c === "[" || image) {
      const link = linkAt(s, image ? i + 1 : i, definitions);
      if (link) {
        push();
        tokens.push(...tokenize(link.text, definitions));
        i = link.end;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const run = runOf(s, i, c);
      const before = i > 0 ? s[i - 1]! : " ";
      const after = i + run < s.length ? s[i + run]! : " ";
      const left = !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
      const right = !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
      push();
      tokens.push({
        kind: "delimiter", char: c, length: run, matched: false,
        open: c === "_" ? left && (!right || isPunctuation(before)) : left,
        close: c === "_" ? right && (!left || isPunctuation(after)) : right,
      });
      i += run;
      continue;
    }
    text += c;
    i++;
  }
  push();
  return tokens;
}

/** How many `c` in a row from `at`. */
function runOf(s: string, at: number, c: string): number {
  let k = at;
  while (s[k] === c) k++;
  return k - at;
}

/** Where the next run of exactly `length` backticks from `from` starts, or -1. */
function backticks(s: string, from: number, length: number): number {
  for (let k = s.indexOf("`", from); k >= 0; k = s.indexOf("`", k)) {
    const run = runOf(s, k, "`");
    if (run === length) return k;
    k += run;
  }
  return -1;
}

/** A link at `open` (its `[`): inline `[text](...)`, a reference `[text][ref]` or `[text][]`, or `[text]` that is defined. */
function linkAt(s: string, open: number, definitions: ReadonlySet<string>): { text: string; end: number } | undefined {
  const close = matching(s, open, "[", "]");
  if (close < 0) return undefined;
  const text = s.slice(open + 1, close);
  if (s[close + 1] === "(") {
    const end = matching(s, close + 1, "(", ")");
    return end < 0 ? undefined : { text, end: end + 1 };
  }
  if (s[close + 1] === "[") {
    const end = matching(s, close + 1, "[", "]");
    if (end < 0) return undefined;
    const reference = s.slice(close + 2, end);
    return definitions.has(labelOf(reference === "" ? text : reference)) ? { text, end: end + 1 } : undefined;
  }
  return definitions.has(labelOf(text)) ? { text, end: close + 1 } : undefined;
}

/** The `closer` that closes the `opener` at `at`, nested pairs and escaped characters skipped; -1 for none. */
function matching(s: string, at: number, opener: string, closer: string): number {
  let depth = 0;
  for (let k = at; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
    } else if (c === opener) {
      depth++;
    } else if (c === closer && --depth === 0) {
      return k;
    }
  }
  return -1;
}
