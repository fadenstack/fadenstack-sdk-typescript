import { describe, expect, it } from "vitest";

import { crc32, inflateEntry, readZip, writeZip, type ZipEntry } from "@fadenstack/skills";

import { SYMLINK_ATTRIBUTES, UNIX_HOST, rawZip, text, utf8 } from "./zipRig.js";

/** The package's own zip reader and writer: stored and deflated entries, and what it refuses before a byte is expanded. */
const budget = () => ({ used: 0, max: 5 * 1024 * 1024 });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function entriesOf(zip: Uint8Array): Promise<readonly ZipEntry[]> {
  const read = readZip(zip, 200);
  if (!read.ok) throw new Error(`not read: ${read.problem}`);
  return read.entries;
}

describe("crc32", () => {
  it("is the standard CRC-32", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("writeZip and readZip", () => {
  it("round trips a deflated entry", async () => {
    const content = utf8("Review each clause. ".repeat(500));

    const zip = await writeZip([{ path: "a/SKILL.md", bytes: content }]);
    const [entry] = await entriesOf(zip);

    expect(entry!.name).toBe("a/SKILL.md");
    expect(entry!.method).toBe(8);
    expect(entry!.compressedSize).toBeLessThan(entry!.size);
    expect(entry!.size).toBe(content.length);
    expect(entry!.isLink).toBe(false);
    expect(entry!.isDirectory).toBe(false);
    const read = await inflateEntry(zip, entry!, 1 << 20, budget());
    expect(read.ok && decode(read.bytes)).toBe(decode(content));
  });

  it("stores an entry that does not get smaller, and an empty one", async () => {
    const zip = await writeZip([
      { path: "tiny.md", bytes: utf8("x") },
      { path: "empty.md", bytes: new Uint8Array(0) },
    ]);

    const [tiny, empty] = await entriesOf(zip);

    expect(tiny!.method).toBe(0);
    expect(empty!.method).toBe(0);
    const read = await inflateEntry(zip, tiny!, 10, budget());
    expect(read.ok && decode(read.bytes)).toBe("x");
    const none = await inflateEntry(zip, empty!, 10, budget());
    expect(none.ok && none.bytes.length).toBe(0);
  });

  it("gives the same bytes for the same files", async () => {
    const files = [{ path: "a.md", bytes: utf8("same ".repeat(100)) }];

    expect(await writeZip(files)).toEqual(await writeZip(files));
  });

  it("keeps the names of the files in order, and UTF-8 names", async () => {
    const zip = await writeZip([
      { path: "b.md", bytes: utf8("1") },
      { path: "a/00fc.md", bytes: utf8("2") },
    ]);

    expect((await entriesOf(zip)).map((e) => e.name)).toEqual(["b.md", "a/00fc.md"]);
  });

  it("reads a stored entry written by another tool", async () => {
    const zip = await rawZip([text("SKILL.md", "stored text", { method: 0 })]);

    const [entry] = await entriesOf(zip);
    const read = await inflateEntry(zip, entry!, 100, budget());

    expect(entry!.method).toBe(0);
    expect(read.ok && decode(read.bytes)).toBe("stored text");
  });

  it("reads the end record before a comment", async () => {
    const zip = await rawZip([text("a.md", "x", { method: 0 })], { comment: utf8("made by a tool") });

    expect((await entriesOf(zip)).map((e) => e.name)).toEqual(["a.md"]);
  });

  it("says an entry is a directory when its name ends with a slash", async () => {
    const zip = await rawZip([{ name: "refs/", method: 0 }, text("refs/a.md", "x")]);

    expect((await entriesOf(zip)).map((e) => e.isDirectory)).toEqual([true, false]);
  });

  it("says an entry is a link: a Unix symbolic link, and not a Windows host's attribute bits", async () => {
    const zip = await rawZip([
      text("link.md", "/etc/passwd", { madeBy: UNIX_HOST, attributes: SYMLINK_ATTRIBUTES }),
      text("file.md", "x", { madeBy: UNIX_HOST, attributes: (0o100644 << 16) >>> 0 }),
      text("dos.md", "x", { madeBy: 20, attributes: SYMLINK_ATTRIBUTES }),
      text("reparse.md", "x", { madeBy: 20, attributes: 0x400 }),
    ]);

    expect((await entriesOf(zip)).map((e) => e.isLink)).toEqual([true, false, false, true]);
  });
});

describe("readZip refuses what a skill's zip never is", () => {
  const notAZip = (zip: Uint8Array) => {
    const read = readZip(zip, 200);
    return read.ok ? "ok" : read.problem;
  };

  it("bytes that are not a zip, an empty input and a truncated zip", async () => {
    const good = await writeZip([{ path: "a.md", bytes: utf8("x".repeat(200)) }]);

    expect(notAZip(utf8("this is not a zip, and long enough to hold an end record"))).toBe("notAZip");
    expect(notAZip(new Uint8Array(0))).toBe("notAZip");
    expect(notAZip(good.slice(0, good.length - 10))).toBe("notAZip");
    expect(notAZip(good.slice(0, 40))).toBe("notAZip");
  });

  it("an encrypted entry (the flag, and the strong encryption flag)", async () => {
    expect(notAZip(await rawZip([text("a.md", "x", { flags: 0x0801 })]))).toBe("notAZip");
    expect(notAZip(await rawZip([text("a.md", "x", { flags: 0x0840 })]))).toBe("notAZip");
  });

  it("a method that is neither stored nor deflated", async () => {
    expect(notAZip(await rawZip([text("a.md", "x", { method: 12, data: utf8("x") })]))).toBe("notAZip");
  });

  it("entry data that lies over another entry's", async () => {
    const zip = await rawZip([text("a.md", "first entry, long enough", { method: 0 }), text("b.md", "second", { method: 0, localOffset: 0 })]);

    expect(notAZip(zip)).toBe("notAZip");
  });

  it("entry data that lies outside the file", async () => {
    expect(notAZip(await rawZip([text("a.md", "x", { method: 0, compressedSize: 5000 })]))).toBe("notAZip");
    expect(notAZip(await rawZip([text("a.md", "x", { method: 0, localOffset: 4000 })]))).toBe("notAZip");
  });

  it("ZIP64 markers", async () => {
    expect(notAZip(await rawZip([text("a.md", "x", { method: 0, size: 0xffffffff })]))).toBe("notAZip");
    expect(notAZip(await rawZip([text("a.md", "x", { method: 0 })], { count: 0xffff }))).toBe("notAZip");
  });

  it("an end record that counts other entries than the directory holds", async () => {
    expect(notAZip(await rawZip([text("a.md", "x", { method: 0 })], { count: 3 }))).toBe("notAZip");
  });

  it("more entries than the caller allows", async () => {
    const zip = await rawZip(Array.from({ length: 12 }, (_, i) => text(`f${i}.md`, "x", { method: 0 })));

    expect(readZip(zip, 11)).toEqual({ ok: false, problem: "tooManyEntries" });
    expect(readZip(zip, 12).ok).toBe(true);
  });

  it("a name that is not UTF-8 reads as no name", async () => {
    const zip = await rawZip([{ name: "x", nameBytes: Uint8Array.from([0x61, 0xff, 0xfe]), bytes: utf8("x"), method: 0 }]);

    expect((await entriesOf(zip))[0]!.name).toBeUndefined();
  });
});

describe("inflateEntry", () => {
  it("stops a deflated entry that passes the limit, whatever the zip says its size is", async () => {
    const zeros = new Uint8Array(600 * 1024);
    const zip = await rawZip([{ name: "z.md", bytes: zeros, size: 100 }]); // the header lies about the size
    const [entry] = await entriesOf(zip);

    const read = await inflateEntry(zip, entry!, entry!.size, budget());

    expect(entry!.size).toBe(100);
    expect(read).toEqual({ ok: false, problem: "tooLarge" });
  });

  it("stops at the total budget over all entries", async () => {
    const zip = await rawZip([{ name: "z.md", bytes: new Uint8Array(100 * 1024) }]);
    const [entry] = await entriesOf(zip);

    const read = await inflateEntry(zip, entry!, 1 << 20, { used: 0, max: 1000 });

    expect(read).toEqual({ ok: false, problem: "tooLarge" });
  });

  it("counts what it expands against the budget", async () => {
    const zip = await writeZip([{ path: "a.md", bytes: utf8("hello world") }]);
    const [entry] = await entriesOf(zip);
    const counter = budget();

    await inflateEntry(zip, entry!, 100, counter);
    await inflateEntry(zip, entry!, 100, counter);

    expect(counter.used).toBe(22);
  });

  it("refuses a stored entry over the limit", async () => {
    const zip = await rawZip([text("a.md", "0123456789", { method: 0 })]);
    const [entry] = await entriesOf(zip);

    expect(await inflateEntry(zip, entry!, 5, budget())).toEqual({ ok: false, problem: "tooLarge" });
  });

  it("refuses a wrong CRC, a size that is not the declared one and data that does not inflate", async () => {
    const wrongCrc = await rawZip([text("a.md", "some text", { crc: 12345 })]);
    const wrongSize = await rawZip([text("a.md", "some text", { size: 3 })]);
    const garbage = await rawZip([text("a.md", "some text", { data: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]), compressedSize: 5 })]);
    const storedMismatch = await rawZip([text("a.md", "some text", { method: 0, size: 3 })]);

    for (const zip of [wrongCrc, wrongSize, garbage, storedMismatch]) {
      const [entry] = await entriesOf(zip);

      expect(await inflateEntry(zip, entry!, 1 << 20, budget())).toEqual({ ok: false, problem: "corrupt" });
    }
  });
});
