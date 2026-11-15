import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The render page of tools/style-renders: the real views of both web skins on the same harness setup the tests use. Not part of `npm test`.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const src = (name: string) => here(`../../packages/${name}/src/index.ts`);

export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@fadenstack/client": src("client"),
      "@fadenstack/agents": src("agents"),
      "@fadenstack/ui": src("ui"),
      "@fadenstack/ui-web": src("ui-web"),
      "@fadenstack/ui-react": src("ui-react"),
      "@fadenstack/ui-vue": src("ui-vue"),
      "@fadenstack/testing/provenance": here("../../packages/testing/src/provenance.ts"),
      "@fadenstack/testing": src("testing"),
      "@fadenstack/provenance": src("provenance"),
      "@fadenstack/skills": src("skills"),
    },
  },
  build: { outDir: here("dist"), emptyOutDir: true, minify: false, cssMinify: false, target: "es2022", chunkSizeWarningLimit: 4000 },
  logLevel: "warn",
});
