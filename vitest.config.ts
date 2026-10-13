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
      "@fadenstack/testing": src("testing"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
