import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT = /\.(ts|tsx|mts|mjs|js|vue|css|json|md)$/;
const SKIPPED = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Every text file the repository's packages and samples are made of. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (TEXT.test(entry.name) && !entry.name.endsWith(".tsbuildinfo")) found.push(path);
  }
  return found;
}

describe("the repository's sources", () => {
  it("are UTF-8, so every editor and tool reads the same text", () => {
    const strict = new TextDecoder("utf-8", { fatal: true });
    const files = [...sources(join(root, "packages")), ...sources(join(root, "samples"))];
    const broken = files.filter((file) => {
      try {
        strict.decode(readFileSync(file));
        return false;
      } catch {
        return true;
      }
    });
    expect(files.length).toBeGreaterThan(100);
    expect(broken.map((file) => relative(root, file))).toEqual([]);
  });
});
