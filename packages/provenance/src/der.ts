/**
 * A small DER writer and reader: what a device-made certificate and an RFC 3161 request and answer need, and nothing more
 * (no dependency; .NET uses `System.Formats.Asn1` here). The reader takes definite lengths only, which is what DER is and
 * what time-stamp authorities send; an indefinite length (BER) reads as malformed.
 */

/** The universal tags the writer and the reader know. */
export const Tag = Object.freeze({
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  objectIdentifier: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
  /** `[0]` constructed: the explicit tag of a SignedData and of an eContent. */
  context0: 0xa0,
  /** [1] constructed: the CRLs of a SignedData, the unsigned attributes of a SignerInfo. */
  context1: 0xa1,
  /** [3] constructed: the extensions of a certificate. */
  context3: 0xa3,
  /** [0] primitive: an implicit SubjectKeyIdentifier (a SignerInfo's sid). */
  context0Primitive: 0x80,
});

/** A DER value that is not well formed (or uses a form this reader does not read). */
export class DerError extends Error {
  constructor(message = "Not a DER value.") {
    super(message);
    this.name = "DerError";
  }
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** A tag, the content's length and the content. */
export function tlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(Uint8Array.of(tag), length(content.length), content);
}

export const sequence = (...parts: Uint8Array[]): Uint8Array => tlv(Tag.sequence, concat(...parts));
export const set = (...parts: Uint8Array[]): Uint8Array => tlv(Tag.set, concat(...parts));
export const explicit0 = (...parts: Uint8Array[]): Uint8Array => tlv(Tag.context0, concat(...parts));
export const octetString = (bytes: Uint8Array): Uint8Array => tlv(Tag.octetString, bytes);
export const nul = (): Uint8Array => tlv(Tag.null, new Uint8Array());
export const bool = (value: boolean): Uint8Array => tlv(Tag.boolean, Uint8Array.of(value ? 0xff : 0x00));
export const utf8String = (text: string): Uint8Array => tlv(Tag.utf8String, new TextEncoder().encode(text));
/** A BIT STRING of whole bytes (no unused bits). */
export const bitString = (bytes: Uint8Array): Uint8Array => tlv(Tag.bitString, concat(Uint8Array.of(0), bytes));

/**
 * An unsigned big-endian integer without its redundant leading zero bytes, at least one byte: DER refuses them, and an ECDSA
 * r or s starts with one about once in 256 (.NET: `DeviceSigner.Minimal`).
 */
export function minimal(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  return start === value.length ? Uint8Array.of(0) : value.slice(start);
}

/**
 * An INTEGER from an unsigned big-endian value: the value must be minimal (a redundant leading zero is no valid DER
 * integer, and throws); a zero byte is added in front when the first bit is set, so the number stays positive.
 */
export function unsignedInteger(value: Uint8Array): Uint8Array {
  if (value.length === 0 || (value.length > 1 && value[0] === 0)) throw new DerError("A DER integer has no redundant leading zero.");
  return tlv(Tag.integer, value[0]! & 0x80 ? concat(Uint8Array.of(0), value) : value);
}

/** A small non-negative INTEGER (a version, a status). */
export function smallInteger(n: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = n; ; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
    if (rest < 256) break;
  }
  return unsignedInteger(Uint8Array.from(bytes));
}

export function objectIdentifier(oid: string): Uint8Array {
  const parts = oid.split(".").map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new DerError("Not an object identifier.");
  const body: number[] = [];
  const base128 = (n: number): void => {
    const digits = [n & 0x7f];
    for (let rest = Math.floor(n / 128); rest > 0; rest = Math.floor(rest / 128)) digits.unshift((rest & 0x7f) | 0x80);
    body.push(...digits);
  };
  base128(parts[0]! * 40 + parts[1]!);
  for (const part of parts.slice(2)) base128(part);
  return tlv(Tag.objectIdentifier, Uint8Array.from(body));
}

const two = (n: number): string => String(n).padStart(2, "0");

/** UTCTime `YYMMDDHHMMSSZ` (years 1950 to 2049). */
export function utcTime(date: Date): Uint8Array {
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(Tag.utcTime, new TextEncoder().encode(text));
}

/** GeneralizedTime `YYYYMMDDHHMMSSZ`, whole seconds. */
export function generalizedTime(date: Date): Uint8Array {
  const text = `${String(date.getUTCFullYear()).padStart(4, "0")}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(Tag.generalizedTime, new TextEncoder().encode(text));
}

/** One value read: its tag, its content, and the whole encoding. */
export interface DerNode {
  readonly tag: number;
  readonly content: Uint8Array;
  readonly raw: Uint8Array;
}

/** Reads the values one after another from a buffer (a SEQUENCE's content, say). */
export class DerReader {
  readonly #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get hasData(): boolean {
    return this.#at < this.#bytes.length;
  }

  /** The next value's tag without reading it. */
  peekTag(): number {
    if (!this.hasData) throw new DerError();
    return this.#bytes[this.#at]!;
  }

  /** The next value, whatever its tag. */
  next(): DerNode {
    const bytes = this.#bytes;
    const start = this.#at;
    if (start + 2 > bytes.length) throw new DerError();
    const tag = bytes[start]!;
    if ((tag & 0x1f) === 0x1f) throw new DerError("High tag numbers are not read.");
    let at = start + 1;
    let size = bytes[at++]!;
    if (size & 0x80) {
      const count = size & 0x7f;
      if (count === 0 || count > 4) throw new DerError("Indefinite or oversized length.");
      if (at + count > bytes.length) throw new DerError();
      size = 0;
      for (let i = 0; i < count; i++) size = size * 256 + bytes[at++]!;
    }
    if (at + size > bytes.length) throw new DerError();
    this.#at = at + size;
    return { tag, content: bytes.subarray(at, at + size), raw: bytes.subarray(start, at + size) };
  }

  /** The next value, which must have this tag. */
  expect(tag: number): DerNode {
    const node = this.next();
    if (node.tag !== tag) throw new DerError(`Expected tag ${tag}, found ${node.tag}.`);
    return node;
  }

  /** The next value as a reader of its content, which must have this tag. */
  open(tag: number): DerReader {
    return new DerReader(this.expect(tag).content);
  }
}

/** An INTEGER's content as an unsigned big-endian value without leading zeros (a negative one throws). */
export function integerBytes(node: DerNode): Uint8Array {
  if (node.tag !== Tag.integer || node.content.length === 0) throw new DerError();
  if (node.content[0]! & 0x80) throw new DerError("Negative integer.");
  return minimal(node.content);
}

/** An INTEGER's content as a number (status codes, versions); throws when it does not fit 31 bits. */
export function integerNumber(node: DerNode): number {
  const bytes = integerBytes(node);
  if (bytes.length > 4 || (bytes.length === 4 && bytes[0]! & 0x80)) throw new DerError("Integer too large.");
  return bytes.reduce((n, b) => n * 256 + b, 0);
}

/** An OBJECT IDENTIFIER's content as dotted text. */
export function oidText(node: DerNode): string {
  if (node.tag !== Tag.objectIdentifier || node.content.length === 0) throw new DerError();
  const arcs: number[] = [];
  let value = 0;
  for (const byte of node.content) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  const first = arcs.shift()!;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...arcs].join(".");
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A Name's whole encoding (tag, length and content), which is what two names are compared by: byte for byte, as RFC 5280 §7.1 allows. */
export function nameBytes(node: DerNode): Uint8Array {
  if (node.tag !== Tag.sequence) throw new DerError("A Name is a SEQUENCE.");
  return node.raw;
}

/**
 * A UTCTime (`YYMMDDHHMMSSZ`, years 1950 to 2049) or GeneralizedTime (`YYYYMMDDHHMMSSZ`) as a date. Only the forms RFC 5280 §4.1.2.5
 * allows (whole seconds, `Z`); any other throws.
 */
export function readTime(node: DerNode): Date {
  const text = new TextDecoder("ascii").decode(node.content);
  const pattern = node.tag === Tag.utcTime ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : node.tag === Tag.generalizedTime ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : undefined;
  const m = pattern?.exec(text);
  if (!m) throw new DerError("Not a time.");
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const full = node.tag === Tag.utcTime ? (year >= 50 ? 1900 + year : 2000 + year) : year;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) throw new DerError("Not a time.");
  return new Date(Date.UTC(full, month - 1, day, hour, minute, second));
}