import vinext from "vinext";
import { defineConfig } from "vite";

// Ritual Atlas is a static, local-first PWA. GitHub Pages is the only release
// target, so the build intentionally has no Worker, database, bucket, or Sites
// runtime bindings.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext()],
});
