// A minimal, strict zip reader and writer (sdk/51 F04): stored and deflate entries only, no ZIP64, no encryption, one disk. The
// platform does the deflate (`DecompressionStream`/`CompressionStream`, in browsers and Node 18+), so there is no dependency. A zip
// that comes in is untrusted: this file reads the central directory and nothing else about an entry before the caller has looked at
// its name, its flags and its sizes; `inflate` reads through a counter that stops at the limit whatever the zip claims. .NET: the
// guards are those of SkillImport.cs.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;

export type ZipProblem = "notAZip" | "tooManyEntries";

/** One entry as the central directory states it. Nothing here has been expanded. */
export interface ZipEntry {
  /** The name as the zip spells it (UTF-8); undefined when the bytes are not valid UTF-8. */
  readonly name: string | undefined;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  /** The entry says it is a link: a Unix symbolic link, or a Windows reparse point. */
  readonly isLink: boolean;
  readonly isDirectory: boolean;
  /** Where the entry's data starts and ends in the file. */
  readonly dataStart: number;
  readonly dataEnd: number;
}

export type ZipRead = { ok: true; entries: readonly ZipEntry[] } | { ok: false; problem: ZipProblem };

const fail = (problem: ZipProblem): ZipRead => ({ ok: false, problem });

/**
 * Reads the central directory of `zip`. Refuses what a skill's zip never is: several disks, ZIP64, encryption, a method other
 * than stored and deflate, an entry whose data lies outside the file or over another entry's, and a count above `maxEntries`.
 */
export function readZip(zip: Uint8Array, maxEntries: number): ZipRead {
  if (zip.length < EOCD_LENGTH) return fail("notAZip");
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is the last 22 bytes plus a comment of up to 65535: the last signature whose comment fits exactly.
  let eocd = -1;
  for (let at = zip.length - EOCD_LENGTH; at >= Math.max(0, zip.length - EOCD_LENGTH - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD && at + EOCD_LENGTH + view.getUint16(at + 20, true) === zip.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return fail("notAZip");
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) return fail("notAZip");
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) return fail("notAZip"); // ZIP64
  if (count > maxEntries) return fail("tooManyEntries");
  if (directoryStart + directorySize > eocd) return fail("notAZip");

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let at = directoryStart;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_LENGTH > directoryStart + directorySize || view.getUint32(at, true) !== CENTRAL) return fail("notAZip");
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const entryDisk = view.getUint16(at + 34, true);
    const attributes = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_LENGTH + nameLength + extraLength + commentLength;
    if (next > directoryStart + directorySize || entryDisk !== 0) return fail("notAZip");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) return fail("notAZip"); // ZIP64
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) return fail("notAZip"); // encrypted
    if (method !== 0 && method !== 8) return fail("notAZip");
    let name: string | undefined;
    try {
      name = decoder.decode(zip.subarray(at + CENTRAL_LENGTH, at + CENTRAL_LENGTH + nameLength));
    } catch {
      name = undefined;
    }
    // The local header says where the data starts (its name and extra field may differ in length from the central one).
    if (localOffset + LOCAL_LENGTH > directoryStart || view.getUint32(localOffset, true) !== LOCAL) return fail("notAZip");
    const dataStart = localOffset + LOCAL_LENGTH + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryStart) return fail("notAZip");
    const hostIsUnix = madeBy >> 8 === 3;
    const unixLink = hostIsUnix && ((attributes >>> 16) & 0xf000) === 0xa000;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      isLink: unixLink || (attributes & 0x400) !== 0,
      isDirectory: name?.endsWith("/") === true,
      dataStart,
      dataEnd,
    });
    at = next;
  }
  // Two entries that share bytes are a zip made to confuse a reader.
  const spans = entries.filter((e) => e.compressedSize > 0).map((e) => [e.dataStart, e.dataEnd] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) return fail("notAZip");
  return { ok: true, entries };
}

export type InflateResult = { ok: true; bytes: Uint8Array } | { ok: false; problem: "tooLarge" | "corrupt" };

/**
 * The entry's bytes: at most `limit` of them, whatever the zip claims (the stream is stopped when it passes the limit), and the
 * size and the CRC it declared. `budget.used` counts what every entry has expanded to, against `budget.max`.
 */
export async function inflateEntry(zip: Uint8Array, entry: ZipEntry, limit: number, budget: { used: number; max: number }): Promise<InflateResult> {
  const data = zip.subarray(entry.dataStart, entry.dataEnd);
  let bytes: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) return { ok: false, problem: "corrupt" };
    if (data.length > limit || budget.used + data.length > budget.max) return { ok: false, problem: "tooLarge" };
    budget.used += data.length;
    bytes = data.slice();
  } else {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const stream = new DecompressionStream("deflate-raw");
    const writer = stream.writable.getWriter();
    // A failure of the writing side shows on the reading side; this only keeps it from being an unhandled rejection.
    void writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        budget.used += value.length;
        if (length > limit || budget.used > budget.max) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, problem: "tooLarge" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, problem: "corrupt" };
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) return { ok: false, problem: "corrupt" };
  return { ok: true, bytes };
}

let table: Uint32Array | undefined;

export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A zip of the files, in order: deflated where that is smaller, else stored; UTF-8 names; a fixed time, so the same skill gives the same bytes. */
export async function writeZip(files: readonly { path: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const packed = file.bytes.length > 0 ? await deflate(file.bytes) : file.bytes;
    const deflated = file.bytes.length > 0 && packed.length < file.bytes.length;
    const data = deflated ? packed : file.bytes;
    const method = deflated ? 8 : 0;
    const crc = crc32(file.bytes);
    const local = new Uint8Array(LOCAL_LENGTH + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x0021, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, LOCAL_LENGTH);
    const header = new Uint8Array(CENTRAL_LENGTH + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    header.set(name, CENTRAL_LENGTH);
    parts.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }
  const directorySize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(EOCD_LENGTH);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
