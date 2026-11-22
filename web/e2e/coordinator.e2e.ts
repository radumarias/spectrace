import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import type { Request } from "@playwright/test";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const PULL = {
  id: "pr-1", repo: "acme/shop", number: 58, title: "Checkout: show decline reason inline", author: "ana", state: "open", draft: false,
  needsYou: true, testsTotal: 1, testsPassed: 0, testsFailed: 1, headRef: "ana/decline-reason", baseRef: "main", htmlUrl: "https://github.com/acme/shop/pull/58",
  additions: 36, deletions: 6, changedFiles: 1, createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T11:00:00Z", mergedAt: null,
  syncedAt: "2026-11-21T11:05:00Z", headSha: "abc123", checks: [], checksState: "failing", body: "", files: [],
};
const msg = (id: string, role: "user" | "coordinator", text: string, extra: Record<string, unknown> = {}) => ({ id, role, text, tools: [], actions: [], ran: [], createdAt: "2026-11-22T13:00:00Z", ...extra });

// T7.2: on a PR, "Can I merge?" sends the screen to the coordinator and its reply lists the open gates,
// with the tools it read and an action that needs a click.
test("'Can I merge?' on a pull request lists its open gates", async ({ page }) => {
  let asked: unknown = null;
  let ran = false;
  const reply = msg("m2", "coordinator", "Not yet. Still open:\n• Tests pass (1 failing)\n• Your approval\n• Agent review finished", {
    tools: ["pull.get(pull=pr-1)"],
    actions: [{ kind: "review_pull", label: "Start agent review", pullId: "pr-1" }],
  });
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [PULL], counts: { needs: 1, open: 1, merged: 0 } },
    "/api/projects/p1/pulls/pr-1": PULL,
    "/api/projects/p1/pulls/pr-1/reviews": { reviews: [] },
    "/api/projects/p1/pulls/pr-1/diff": { files: [] },
    "/api/projects/p1/coordinator": (req: Request) => {
      if (req.method() === "GET") return { messages: [] };
      asked = req.postDataJSON();
      return { messages: [msg("m1", "user", "Can I merge?"), reply] };
    },
    "/api/projects/p1/coordinator/m2/actions/0": () => {
      ran = true;
      return { ok: true, messages: [{ ...reply, ran: [0] }, msg("m3", "coordinator", "I started the Reviewer agent on this pull request.")] };
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/pr/pr-1");
  await expect(page.getByRole("heading", { name: PULL.title })).toBeVisible();
  await page.getByRole("button", { name: /coordinator/ }).first().click();
  const panel = page.getByRole("complementary", { name: "Coordinator" });
  await expect(panel.getByText("here: Pull request")).toBeVisible();
  await expect(panel.getByText("shop #58")).toBeVisible();

  await panel.getByRole("button", { name: "Can I merge?" }).click();
  await expect(panel.getByText("Tests pass (1 failing)", { exact: false })).toBeVisible();
  await expect(panel.getByText("Your approval", { exact: false })).toBeVisible();
  await expect(panel.getByText("pull.get(pull=pr-1)")).toBeVisible();
  expect(asked).toEqual({ text: "Can I merge?", screen: { route: "pr", pullId: "pr-1" } });
  await expectNoHorizontalScroll(page);

  // Nothing runs until the click.
  expect(ran).toBe(false);
  await panel.getByRole("button", { name: "Start agent review" }).click();
  await expect(panel.getByText("I started the Reviewer agent on this pull request.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start agent review ✓" })).toBeDisabled();
  expect(ran).toBe(true);
  expect(errors).toEqual([]);
});

test("typing a question and Send asks the coordinator", async ({ page }) => {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/coordinator": (req: Request) =>
      req.method() === "GET" ? { messages: [] } : { messages: [msg("m1", "user", "hello"), msg("m2", "coordinator", "Nothing waits on you right now.")] },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  await page.goto("/prs");
  await page.getByRole("button", { name: /coordinator/ }).first().click();
  const panel = page.getByRole("complementary", { name: "Coordinator" });
  await panel.getByLabel("Message the coordinator").fill("hello");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText("Nothing waits on you right now.")).toBeVisible();
  await expect(panel.getByLabel("Message the coordinator")).toHaveValue("");
});
