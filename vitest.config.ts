import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against the sources: no build step between an edit and a test.
export default defineConfig({
  resolve: {
    alias: {
      "@fadenstack/client": src("client"),
      "@fadenstack/agents": src("agents"),
      "@fadenstack/ui": src("ui"),
      "@fadenstack/ui-react": src("ui-react"),
      "@fadenstack/testing": src("testing"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
