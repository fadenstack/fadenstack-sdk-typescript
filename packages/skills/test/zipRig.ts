/**
 * A tiny zip builder for the tests: the package's own `writeZip` only writes honest zips, and the hostile ones (a link, a lying header,
 * a wrong CRC, an encrypted flag, entries that share bytes) need every field of the headers in the test's hand.
 */

const encoder = new TextEncoder();

export interface RawEntry {
  /** The name as the zip spells it. */
  name: string;
  /** What the entry holds (default: empty). */
  bytes?: Uint8Array;
  /** 0 stored, 8 deflated (default 8). */
  method?: number;
  /** The "version made by" field (host in the high byte; 3 is Unix). */
  madeBy?: number;
  /** The external attributes (a Unix mode sits in the high 16 bits). */
  attributes?: number;
  flags?: number;
  /** Overrides of what the headers say (a lying zip). */
  crc?: number;
  size?: number;
  compressedSize?: number;
  /** The bytes stored as the entry's data, instead of the (compressed) content. */
  data?: Uint8Array;
  /** The name as bytes (for a name that is not UTF-8). */
  nameBytes?: Uint8Array;
  /** Where the local header is said to be, instead of where it is. */
  localOffset?: number;
}

export interface RawZipOptions {
  comment?: Uint8Array;
  /** What the end record says about the number of entries, instead of the truth. */
  count?: number;
}

/** The text as bytes. */
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** An entry of text. */
export function text(name: string, content: string, more: Partial<RawEntry> = {}): RawEntry {
  return { name, bytes: utf8(content), ...more };
}

let table: Uint32Array | undefined;

export function crc(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function through(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, bytes: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return join(chunks);
}

export function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Raw deflate, as a zip entry holds it. */
export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return through(new CompressionStream("deflate-raw") as never, bytes);
}

/** A zip with the fields as the entries say them. */
export async function rawZip(entries: readonly RawEntry[], options: RawZipOptions = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const content = entry.bytes ?? new Uint8Array(0);
    const method = entry.method ?? 8;
    const data = entry.data ?? (method === 8 ? await deflateRaw(content) : content);
    const name = entry.nameBytes ?? encoder.encode(entry.name);
    const entryCrc = entry.crc ?? crc(content);
    const compressedSize = entry.compressedSize ?? data.length;
    const size = entry.size ?? content.length;
    const flags = entry.flags ?? 0x0800;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x0021, true);
    lv.setUint32(14, entryCrc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, entry.madeBy ?? 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, entryCrc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (entry.attributes ?? 0) >>> 0, true);
    cv.setUint32(42, entry.localOffset ?? offset, true);
    header.set(name, 46);
    parts.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }
  const comment = options.comment ?? new Uint8Array(0);
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.count ?? entries.length, true);
  ev.setUint16(10, options.count ?? entries.length, true);
  ev.setUint32(12, central.reduce((sum, c) => sum + c.length, 0), true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  return join([...parts, ...central, end]);
}

/** The Unix mode of a symbolic link, in the high 16 bits of the external attributes. */
export const SYMLINK_ATTRIBUTES = (0o120777 << 16) >>> 0;
/** "Made by" a Unix host. */
export const UNIX_HOST = (3 << 8) | 20;
