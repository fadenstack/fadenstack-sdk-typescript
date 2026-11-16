import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const src = (name: string) => here(`../../packages/${name}/src/index.ts`);

// The sample runs against the SDK's sources, like the tests: no build step between a change and the page.
// `npm run sample:web` serves it; `npm run sample:web:build` builds it into `dist/` here.
export default defineConfig({
  root: here("."),
  resolve: {
    alias: {
      "@fadenstack/client": src("client"),
      "@fadenstack/agents": src("agents"),
      "@fadenstack/ui": src("ui"),
      "@fadenstack/ui-web/styles.css": here("../../packages/ui-web/styles.css"),
      "@fadenstack/ui-web": src("ui-web"),
      "@fadenstack/ui-react": src("ui-react"),
      "@fadenstack/provenance": src("provenance"),
    },
  },
  build: { outDir: here("dist"), emptyOutDir: true, target: "es2022" },
});
