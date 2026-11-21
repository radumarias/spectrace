import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// `vite dev` runs the Worker from ../worker in the same process, so the web app
// and /api share one origin and one port. Unit tests don't need the Worker.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === "test"
      ? []
      : [cloudflare({ configPath: "../worker/wrangler.toml", persistState: { path: "../worker/.wrangler/state" } })]),
  ],
  test: { environment: "jsdom" },
}));
