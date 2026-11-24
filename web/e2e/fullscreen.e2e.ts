import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import SPEC from "./spec-checkout.json" with { type: "json" };

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const SUMMARY = Object.fromEntries(Object.entries(SPEC).filter(([k]) => !["source", "model", "diagnostics", "anchors", "sha", "defaultBranch", "devpage"].includes(k)));

async function open(page: import("@playwright/test").Page) {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/specs": [SUMMARY],
    "/api/projects/p1/specs/s1": SPEC,
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
}

// The left menu folds to an icon rail, the choice is remembered, and every diagram has its own full-screen button.
test("the left menu collapses and stays collapsed, and a Markdown diagram opens full screen", async ({ page }, info) => {
  await open(page);
  const errors = trackErrors(page);
  await page.goto("/spec/s1?tab=md");
  const phone = info.project.use.viewport!.width < 760;

  if (!phone) {
    const side = page.getByRole("navigation", { name: "Main" }).first();
    const wide = (await side.boundingBox())!.width;
    await page.getByRole("button", { name: "Collapse menu" }).click();
    await expect.poll(async () => (await side.boundingBox())!.width).toBeLessThan(wide / 2);
    await expect(page.getByRole("button", { name: "Expand menu" })).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand menu" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Spec", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Expand menu" }).click();
    await expect.poll(async () => (await side.boundingBox())!.width).toBe(wide);
  }

  await page.getByRole("button", { name: "Show Diagram full screen" }).first().click();
  const fs = page.getByRole("dialog", { name: "Diagram" });
  await expect(fs).toBeVisible();
  await expect(fs.locator(".pele-node").first()).toBeVisible();
  await fs.getByRole("button", { name: "Zoom in" }).click();
  await expect(fs.getByText("125%")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(fs).toBeHidden();
  expect(errors).toEqual([]);
});
