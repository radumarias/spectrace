import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  // Same SQL files that `wrangler d1 migrations apply` runs, applied to a
  // fresh in-memory D1 in test/setup.ts.
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Sign-in tests: GitHub is mocked in test/auth.test.ts, never called.
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "shh",
            PUBLIC_URL: "http://localhost:5173",
            GITHUB_OAUTH_URL: "http://github.test",
            GITHUB_API_URL: "http://api.github.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
