import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// A library build: one ES module, not minified (the app's bundler minifies), with Vue and the other Fadenstack
// packages left as imports. The type declarations come from vue-tsc (tsconfig.build.json).
export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: "index",
    },
    target: "es2022",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ["vue", /^@fadenstack\//],
    },
  },
});
