import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SDK_VERSION } from "@fadenstack/client";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const packages = ["client", "agents", "ui", "ui-react", "testing"];

describe("what a release publishes", () => {
  it("reports the package's version as SDK_VERSION", () => {
    expect(SDK_VERSION).toBe(JSON.parse(read("packages/client/package.json")).version);
  });

  it.each(packages)("ships LICENSE and NOTICE in %s as the repository has them", (name) => {
    expect(read(`packages/${name}/LICENSE`)).toBe(read("LICENSE"));
    expect(read(`packages/${name}/NOTICE`)).toBe(read("NOTICE"));
  });
});
