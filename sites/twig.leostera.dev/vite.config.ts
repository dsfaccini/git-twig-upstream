import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { loadBenchmarks } from "./scripts/benchmarks.ts";
import { previewFile } from "./scripts/preview.ts";

const virtualId = "virtual:twig-benchmarks";
function benchmarkData(): Plugin {
  return {
    name: "twig-benchmark-data",
    resolveId(id) {
      if (id === virtualId) return "\0" + virtualId;
    },
    load(id) {
      if (id !== "\0" + virtualId) return;
      this.addWatchFile(fileURLToPath(previewFile));
      return `export default ${JSON.stringify(loadBenchmarks())}`;
    },
  };
}

export default defineConfig({
  plugins: [benchmarkData(), react(), cloudflare()],
  server: { host: "127.0.0.1", port: 5178, fs: { allow: ["../.."] } },
});
