import type { Request } from "@playwright/test";
import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

const repo = (id: string, full_name: string) => ({ id, github_repo_id: null, full_name, default_branch: "main", index_state: "ready" });
const PROJECT = { id: "p1", name: "Shop", context: "", created_at: "2026-11-21T10:00:00Z", updated_at: "2026-11-21T10:00:00Z", repos: [repo("r1", "acme/shop"), repo("r2", "acme/api")] };
const pull = (id: string, repoName: string, number: number, title: string, o: Record<string, unknown> = {}) => ({
  id, repo: repoName, number, title, author: "ana", state: "open", draft: false, needsYou: true, testsTotal: 3, testsPassed: 3, testsFailed: 0, headRef: "feat", baseRef: "main",
  htmlUrl: "https://github.com/x", additions: 10, deletions: 2, changedFiles: 3,
  createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T10:00:00Z", mergedAt: null, syncedAt: "2026-11-21T10:00:00Z", ...o,
});
const SEEDED = [
  pull("a", "acme/shop", 142, "Add refunds to checkout"),
  pull("b", "acme/api", 7, "Retry limit for declines", { draft: true, needsYou: false }),
  pull("c", "acme/shop", 140, "Fix cart total", { state: "merged", needsYou: false, mergedAt: "2026-11-20T10:00:00Z" }),
];

test("the inbox matches the seeded pull requests and the filters change it", async ({ page }) => {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": (req: Request) => {
      const q = new URL(req.url()).searchParams;
      const f = q.get("filter");
      const r = q.get("repo");
      const pulls = SEEDED.filter((p) => (f === "needs" ? p.needsYou : f === "open" ? p.state === "open" : p.state === "merged") && (!r || p.repo === r));
      return { pulls, counts: { needs: 1, open: 2, merged: 1 } };
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/prs");

  await expect(page.getByRole("heading", { name: "1 pull request needs you" })).toBeVisible();
  const rows = page.locator("a.pr-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Add refunds to checkout");
  await expect(rows.first()).toContainText("acme/shop #142");
  await expect(rows.first()).toContainText("tests 3/3");
  await expect(rows.first()).toContainText("risk not rated");
  await expect(rows.first()).toContainText("needs you");
  await expect(rows.first()).toHaveAttribute("href", "/pr/a");
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Open · 2" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("draft");

  await page.getByRole("button", { name: "api" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Retry limit for declines");

  await page.getByRole("button", { name: "All repos" }).click();
  await page.getByRole("button", { name: "Merged · 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Fix cart total");
  await expect(rows.first()).toContainText("merged");
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("an empty inbox says nothing waits on you", async ({ page }) => {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  await page.goto("/prs");
  await expect(page.getByRole("heading", { name: "Nothing waits on you" })).toBeVisible();
  await expect(page.getByText("Nothing needs you here.")).toBeVisible();
});
