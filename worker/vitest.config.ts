import { defineConfig } from "vitest/config";
import { TEST_APP_PRIVATE_KEY } from "./test/app-key";
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
            GITHUB_APP_ID: "12345",
            GITHUB_APP_SLUG: "spectrace-test",
            GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
            GITHUB_WEBHOOK_SECRET: "whsec-test",
            // GitLab is faked in test/gitlab.test.ts, never called.
            GITLAB_URL: "http://gitlab.test",
            GITLAB_CLIENT_ID: "glid",
            GITLAB_CLIENT_SECRET: "glsecret",
            GITLAB_WEBHOOK_SECRET: "glwh-test",
            // Claude is faked in test/ai.test.ts, never called.
            ANTHROPIC_BASE_URL: "http://anthropic.test",
            // AES-GCM key for saved API keys (test/user-keys.test.ts): 32 zero bytes.
            SECRETS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            // Claude Code is faked in test/claude-code.test.ts, never run.
            CLAUDE_CODE_ORIGIN: "http://claude-code.test",
            // devpage server is faked in test/index-job.test.ts, never run.
            DEVPAGE_ORIGIN: "http://devpage.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
