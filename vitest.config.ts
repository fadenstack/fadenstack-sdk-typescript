import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const src = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against the sources: no build step between an edit and a test.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@fadenstack/client": src("client"),
      "@fadenstack/agents": src("agents"),
      "@fadenstack/ui": src("ui"),
      "@fadenstack/ui-web": src("ui-web"),
      "@fadenstack/ui-react": src("ui-react"),
      "@fadenstack/ui-vue": src("ui-vue"),
      // Before the package itself: an alias matches by prefix.
      "@fadenstack/testing/provenance": fileURLToPath(new URL("./packages/testing/src/provenance.ts", import.meta.url)),
      "@fadenstack/testing": src("testing"),
      "@fadenstack/provenance": src("provenance"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
  },
});
