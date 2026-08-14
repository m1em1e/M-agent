import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/renderer",
  // Production is loaded through file://, so emitted assets must stay relative.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@core": fileURLToPath(new URL("./src/core", import.meta.url))
    }
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true
  }
});
