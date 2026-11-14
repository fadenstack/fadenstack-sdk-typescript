import { describe, expect, it } from "vitest";

import { FadenYamlError, MAX_YAML_BYTES, parseFadenYaml, type YamlValue } from "@fadenstack/skills";

/**
 * The reader of `faden.yaml` (untrusted input) keeps the limits of core's `safe_yaml.py`: 32 KiB, 8 levels, no anchors, aliases or tags,
 * and reads plain scalars as PyYAML's safe loader does. The tables are the .NET `FadenYamlTests`, which were checked against PyYAML's
 * `safe_load`.
 */
function show(value: YamlValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return `[${value.map(show).join(",")}]`;
  return `{${[...value].map(([k, v]) => `${k}:${show(v)}`).join(",")}}`;
}

describe("faden.yaml, read", () => {
  it.each([
    ["", "null"],
    ["# only a comment\n", "null"],
    ["a: 1", "{a:1}"],
    ["---\na: 1\n", "{a:1}"],
    ["title: Slide design\npriority: 60\n", '{title:"Slide design",priority:60}'],
    ["tags: [powerpoint, presentations, design]", '{tags:["powerpoint","presentations","design"]}'],
    ["tags:\n  - one\n  - two\n", '{tags:["one","two"]}'],
    ["tags:\n- one\n- two\nnext: 1\n", '{tags:["one","two"],next:1}'],
    ["a:\n  b:\n    c: x\n  d: y\n", '{a:{b:{c:"x"},d:"y"}}'],
    ["list:\n  - name: a\n    n: 1\n  - name: b\n", '{list:[{name:"a",n:1},{name:"b"}]}'],
    ["a: 'it''s'\nb: \"tab\\there\"\n", '{a:"it\'s",b:"tab\there"}'],
    ['a: x # a comment\nb: "has # inside"\n', '{a:"x",b:"has # inside"}'],
    ["a: don't stop\n", '{a:"don\'t stop"}'],
    ["url: http://x.y/z\n", '{url:"http://x.y/z"}'],
    ["a: {x: 1, y: [2, 3]}\n", "{a:{x:1,y:[2,3]}}"],
    ["a: [one,\n  two]\n", '{a:["one","two"]}'],
    ["a: ~\nb: null\nc:\nd: Null\n", "{a:null,b:null,c:null,d:null}"],
    ["a: true\nb: False\nc: yes\nd: No\ne: on\nf: OFF\n", "{a:true,b:false,c:true,d:false,e:true,f:false}"],
    ['a: 12\nb: -3\nc: +4\nd: 0x1F\ne: 010\nf: 1_000\ng: 09\nh: 1.5\ni: "12"\n', '{a:12,b:-3,c:4,d:31,e:8,f:1000,g:"09",h:"1.5",i:"12"}'],
    ["a: 1\na: 2\n", "{a:2}"],
    ['"quoted key": 1\n', "{quoted key:1}"],
    ["a: x\r\nb: y\r\n", '{a:"x",b:"y"}'],
  ])("%j reads to %s", (text, expected) => {
    expect(show(parseFadenYaml(text))).toBe(expected);
  });

  it.each([
    ["a: &x [1]\nb: *x\n", "anchors"],
    ["a: &x 1\n", "anchors"],
    ["b: *x\n", "aliases"],
    ["a: !!python/object:os.system x\n", "tags"],
    ["a: !tag x\n", "tags"],
    ["a: |\n  text\n", "block scalars"],
    ["a: >\n  text\n", "block scalars"],
    ["a: 1\n---\nb: 2\n", "more than one document"],
    ["a: 1\n...\n", "more than one document"],
    ["a:\n\tb: 1\n", "tab"],
    ["a: [1, 2\n", "bracket"],
    ['a: "open\n', "quoted"],
    ['a: "x" y\n', "quoted"],
    ["a: b: c\n", "map"],
    ["? complex\n: 1\n", "complex keys"],
    ["a: 1\n b: 2\n", "laid out"],
    ["a: 1\nb\n", "laid out"],
    ["a: x\u200by\n", "invisible"],
    ["a: x\u202ey\n", "invisible"],
    ["a: x\u0007y\n", "invisible"],
    ['a: "x\\u0007y"\n', "invisible"],
    ['a: "\\q"\n', "escape"],
  ])("%j is refused: %s", (text, why) => {
    let error: unknown;
    try {
      parseFadenYaml(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FadenYamlError);
    expect((error as FadenYamlError).message.toLowerCase()).toContain(why.toLowerCase());
  });

  it("refuses text over 32 KiB and reads text at the limit", () => {
    const atLimit = `a: ${"x".repeat(MAX_YAML_BYTES - 4)}\n`;
    expect(new TextEncoder().encode(atLimit).length).toBe(MAX_YAML_BYTES);
    expect(parseFadenYaml(atLimit)).toBeInstanceOf(Map);
    const over = `a: ${"x".repeat(MAX_YAML_BYTES)}\n`;
    expect(() => parseFadenYaml(over)).toThrow(/32 KiB/);
    // bytes, not characters: 3-byte characters
    const wide = `a: ${"\u20ac".repeat(Math.floor(MAX_YAML_BYTES / 3) + 1)}\n`;
    expect(() => parseFadenYaml(wide)).toThrow(FadenYamlError);
  });

  it("counts every node as a level and stops after eight", () => {
    // PyYAML's loader counts maps, lists and scalars alike: a map of a map of ... with a scalar at the bottom.
    const nest = (maps: number) => Array.from({ length: maps }, (_, i) => `${" ".repeat(2 * i)}k:${i === maps - 1 ? " v\n" : "\n"}`).join("");
    expect(parseFadenYaml(nest(7))).not.toBeNull(); // 7 maps and the scalar: 8 levels
    expect(() => parseFadenYaml(nest(8))).toThrow(/8 levels/);
    expect(parseFadenYaml(`a: ${"[".repeat(6)}${"]".repeat(6)}\n`)).not.toBeNull(); // map + 6 lists: 7, the empty innermost is a list
    expect(parseFadenYaml(`a: ${"[".repeat(7)}${"]".repeat(7)}\n`)).not.toBeNull(); // PyYAML reads this too
    expect(() => parseFadenYaml(`a: ${"[".repeat(8)}${"]".repeat(8)}\n`)).toThrow(FadenYamlError);
    expect(() => parseFadenYaml(`a: ${"[".repeat(200)}${"]".repeat(200)}\n`)).toThrow(FadenYamlError);
    expect(() => parseFadenYaml(Array.from({ length: 200 }, (_, i) => `${" ".repeat(2 * i)}- \n`).join(""))).toThrow(FadenYamlError);
  });

  it("is bounded by its size, because nothing can be referenced", () => {
    // The "billion laughs" shape needs aliases; without them the biggest list a 32 KiB file makes is its own size.
    const many = `a: [${Array.from({ length: 10000 }, () => "x").join(",")}]\n`;
    const map = parseFadenYaml(many) as Map<string, YamlValue>;
    expect((map.get("a") as YamlValue[]).length).toBe(10000);
  });

  it("holds a key such as __proto__ as a key and nothing else", () => {
    const map = parseFadenYaml("__proto__: 1\nconstructor: 2\n") as Map<string, YamlValue>;
    expect([...map.keys()]).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>)["__proto__"]).toBe(Object.prototype);
  });

  it("reads an integer as .NET's long does: 64 bits, else text", () => {
    const map = parseFadenYaml("a: 9223372036854775807\nb: 9223372036854775808\nc: -9223372036854775807\nd: 0xFFFFFFFFFFFFFFFF\ne: 0x1ffffffffffffffff\n") as Map<string, YamlValue>;
    expect(map.get("a")).toBe(9223372036854775807n);
    expect(map.get("b")).toBe("9223372036854775808");
    expect(map.get("c")).toBe(-9223372036854775807n);
    expect(map.get("d")).toBe(-1n);
    expect(map.get("e")).toBe("0x1ffffffffffffffff");
  });
});
