import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const PULL = {
  id: "pr-1", repo: "acme/shop", number: 58, title: "Checkout: show decline reason inline", author: "ana", state: "open", draft: false,
  needsYou: true, headRef: "ana/decline-reason", baseRef: "main", htmlUrl: "https://github.com/acme/shop/pull/58",
  additions: 36, deletions: 6, changedFiles: 2, createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T11:00:00Z", mergedAt: null,
  syncedAt: "2026-11-21T11:05:00Z", headSha: "abc123",
  body: "The declined screen shows why the card was declined, next to the retry button.",
  files: [
    { path: "src/checkout/Declined.tsx", status: "modified", previousPath: null, additions: 31, deletions: 6 },
    { path: "src/checkout/Declined.test.tsx", status: "added", previousPath: null, additions: 5, deletions: 0 },
  ],
};

// Opens a pull request and reads its description and files, with no horizontal scroll and no console errors.
// The inbox that links here is T2.4; this opens the same /pr/<id> address its rows use.
test("a pull request shows its header, description and files", async ({ page }) => {
  await mockApi(page, { "/api/me": USER, "/api/projects": [PROJECT], "/api/projects/p1/pulls": { pulls: [PULL], counts: { needs: 1, open: 1, merged: 0 } }, "/api/projects/p1/pulls/pr-1": PULL, "/api/projects/p1/pulls/pr-1/reviews": { reviews: [] } });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/pr/pr-1");

  await expect(page.getByRole("heading", { name: PULL.title })).toBeVisible();
  await expect(page.getByText("checks not synced yet")).toBeVisible();
  await expect(page.getByText(PULL.body)).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("tab", { name: "Files · 2" }).click();
  await expect(page.getByRole("cell", { name: "src/checkout/Declined.tsx" })).toBeVisible();
  await expect(page.getByText("+31")).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
