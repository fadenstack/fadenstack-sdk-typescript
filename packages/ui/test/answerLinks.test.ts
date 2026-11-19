import { describe, expect, it } from "vitest";

import { parseBlocks } from "../src/markdown/parse.js";

/** Every link the parsed Markdown would draw, as its address. */
function links(source: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const node = value as { kind?: string; href?: string };
      if (node.kind === "link" && typeof node.href === "string") found.push(node.href);
      Object.values(value).forEach(walk);
    }
  };
  walk(parseBlocks(source));
  return found;
}

describe("links in an answer", () => {
  it("open only for http and https", () => {
    expect(links("[site](https://example.com/a) and [plain](http://example.com/b)")).toEqual(["https://example.com/a", "http://example.com/b"]);
  });

  it("never for mailto, file or other schemes: their text stays, the link does not", () => {
    const source = "[write](mailto:a@b.example?subject=x&body=secret) [disk](file:///C:/Windows) [run](javascript:alert(1)) a@b.example";
    expect(links(source)).toEqual([]);
    expect(JSON.stringify(parseBlocks(source))).toContain("write");
  });
});
