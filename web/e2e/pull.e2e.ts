import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const PULL = {
  id: "pr-1", repo: "acme/shop", number: 58, title: "Checkout: show decline reason inline", author: "ana", state: "open", draft: false,
  needsYou: true, testsTotal: 0, testsPassed: 0, testsFailed: 0, headRef: "ana/decline-reason", baseRef: "main", htmlUrl: "https://github.com/acme/shop/pull/58",
  additions: 36, deletions: 6, changedFiles: 2, createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T11:00:00Z", mergedAt: null,
  syncedAt: "2026-11-21T11:05:00Z", headSha: "abc123", checks: [], checksState: "none",
  body: "The declined screen shows why the card was declined, next to the retry button.",
  files: [
    { path: "src/checkout/Declined.tsx", status: "modified", previousPath: null, additions: 31, deletions: 6 },
    { path: "src/checkout/Declined.test.tsx", status: "added", previousPath: null, additions: 5, deletions: 0 },
  ],
};

// Opens a pull request and reads its description and files, with no horizontal scroll and no console errors.
// The inbox that links here is T2.4; this opens the same /pr/<id> address its rows use.
test("a pull request shows its header, description and files", async ({ page }) => {
  await mockApi(page, { "/api/me": USER, "/api/projects": [PROJECT], "/api/projects/p1/pulls": { pulls: [PULL], counts: { needs: 1, open: 1, merged: 0 } }, "/api/projects/p1/pulls/pr-1": PULL, "/api/projects/p1/pulls/pr-1/reviews": { reviews: [] }, "/api/projects/p1/pulls/pr-1/diff": { files: [{ path: "src/checkout/Declined.tsx", patch: "@@ -10,3 +10,4 @@ export function Declined() {\n   const reason = useReason();\n-  return <p>Declined</p>;\n+  return <p>Declined: {reason} and a very long line that must scroll inside the diff and never widen the page at 390 px wide</p>;\n }" }] } });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/pr/pr-1");

  await expect(page.getByRole("heading", { name: PULL.title })).toBeVisible();
  await expect(page.getByText("no checks")).toBeVisible();
  await expect(page.getByText(PULL.body)).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("tab", { name: "Files · 2" }).click();
  await expect(page.getByText("src/checkout/Declined.tsx")).toBeVisible();
  await expect(page.getByText("+31")).toBeVisible();
  await page.getByRole("button", { name: /Declined\.tsx\b(?!.*test)/ }).click();
  await expect(page.getByRole("table", { name: "Changes" })).toBeVisible();
  await expect(page.getByText("return <p>Declined</p>;")).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

// T2.7: a webhook changes the pull request, the project's event socket says so, and the open page follows without a reload.
test("an open pull request page follows a webhook without a reload", async ({ page }) => {
  let current = PULL;
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [PULL], counts: { needs: 1, open: 1, merged: 0 } },
    "/api/projects/p1/pulls/pr-1": () => current,
    "/api/projects/p1/pulls/pr-1/reviews": { reviews: [] },
    "/api/projects/p1/pulls/pr-1/diff": { files: [] },
  });
  let seq = 0;
  // React's dev double-mount opens the socket twice and closes the first, so always talk to the newest one.
  let newest: { send: (message: string) => void } | undefined;
  await page.routeWebSocket(/\/api\/projects\/p1\/events/, (ws) => {
    newest = ws;
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/pr/pr-1");
  await expect(page.getByRole("heading", { name: PULL.title })).toBeVisible();
  await expect(page.getByText("no checks")).toBeVisible();

  // CI finishes on GitHub: the check_run webhook is stored and announced.
  current = {
    ...PULL,
    title: "Checkout: show the decline reason",
    checksState: "passing",
    checks: [{ name: "Web (tsc, vitest)", status: "completed", conclusion: "success", url: "", startedAt: null, completedAt: null }],
  } as typeof PULL;
  await expect.poll(() => newest).toBeDefined();
  newest!.send(JSON.stringify({ id: ++seq, projectId: "p1", jobId: "wh-1", event: "pr.updated", data: { repo: "acme/shop", number: 58, cause: "check_run.completed" }, createdAt: "2026-11-21T12:00:00Z" }));

  await expect(page.getByRole("heading", { name: "Checkout: show the decline reason" })).toBeVisible();
  await expect(page.getByText("tests 1/1")).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
