import type { Request } from "@playwright/test";
import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

const repo = (full_name: string, provider: string) => ({
  id: `r-${full_name}`,
  provider,
  github_repo_id: null,
  full_name,
  default_branch: "main",
  index_state: "ready",
  languages: {},
  file_count: 4,
  tree_truncated: false,
  indexed_at: null,
  index_error: null,
});

// Project settings: connect a GitLab account with a token and add one of its repos, at both widths.
test("connects GitLab and adds a GitLab repo", async ({ page }, info) => {
  let account: { username: string; kind: string } | null = null;
  const project = { id: "p1", name: "Shop app", context: "Web shop.", created_at: "x", updated_at: "x", repos: [repo("acme/shop", "github")] };
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": () => [project],
    "/api/github/repos": [],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/gitlab": () => ({ configured: true, url: "https://gitlab.juyo.dev", oauth: true, account }),
    "/api/gitlab/token": () => {
      account = { username: "radu", kind: "token" };
      return { configured: true, url: "https://gitlab.juyo.dev", oauth: true, account };
    },
    "/api/gitlab/repos": () =>
      account ? [{ id: 77, full_name: "juyo/platform/api", name: "api", default_branch: "main", private: true, html_url: "https://gitlab.juyo.dev/juyo/platform/api" }] : [],
    "/api/projects/p1": (req: Request) => {
      const body = req.postDataJSON() as { repos?: { full_name: string; provider?: string }[] };
      if (body.repos) project.repos = body.repos.map((r) => repo(r.full_name, r.provider ?? "github"));
      return project;
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/project");
  await expect(page.getByRole("link", { name: "Connect GitLab" })).toHaveAttribute("href", "/api/gitlab/connect");
  await page.getByRole("button", { name: "Use a personal access token instead" }).click();
  await page.getByLabel("Personal access token").fill("glpat-abc");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("@radu")).toBeVisible();
  await page.getByRole("button", { name: "+ juyo/platform/api" }).click();
  await expect(page.locator(".repo-chip", { hasText: "juyo/platform/api" })).toContainText("GitLab");
  await expectNoHorizontalScroll(page);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/gitlab-settings-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});
