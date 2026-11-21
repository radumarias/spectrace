import { defineConfig } from "@playwright/test";

// End-to-end tests run the web app and the Worker together, the way `just dev` does:
// `vite` with the Cloudflare plugin serves the SPA and /api/* on one port, backed by
// the local D1 database (run `just migrate` first, or use `just e2e`, which does).
// GitHub and Claude are never called: tests mock /api with e2e/fixtures.ts, except
// for the one spec that asks the real Worker for /api/health.
const port = Number(process.env.E2E_PORT ?? 5174);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  // `.e2e.ts` keeps these out of vitest, which runs `*.test.ts` and `*.spec.ts` under src/.
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // Every spec runs at both widths from the prototype: desktop 1440 px and phone 390 px.
  projects: [
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "phone-390", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
  },
});
