import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Copies the SpessaSynth audio worklet processor into the build root so
 * `new URL("spessasynth_processor.min.js", import.meta.url)` resolves under
 * both the dev server and the packaged file:// renderer.
 */
function copyWorkletProcessor(): Plugin {
  let outDir = "";
  const workletPath = () => require.resolve("spessasynth_lib/dist/spessasynth_processor.min.js");
  return {
    name: "copy-spessasynth-worklet",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/spessasynth_processor.min.js", (_req, res) => {
        const { readFileSync } = require("node:fs");
        res.setHeader("Content-Type", "application/javascript");
        res.end(readFileSync(workletPath()));
      });
    },
    closeBundle() {
      const source = workletPath();
      mkdirSync(outDir, { recursive: true });
      copyFileSync(source, join(outDir, "spessasynth_processor.min.js"));
      console.error("[copy-spessasynth-worklet] copied to", join(outDir, "spessasynth_processor.min.js"));
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  // Production is loaded through file://, so emitted assets must stay relative.
  base: "./",
  plugins: [react(), copyWorkletProcessor()],
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
