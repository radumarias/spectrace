import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
// fixtures/shop as the T4.4 index serves it, produced from the real parser and scanner.
import SPEC from "./spec-checkout.json" with { type: "json" };

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const SUMMARY = Object.fromEntries(Object.entries(SPEC).filter(([k]) => !["source", "model", "diagnostics", "anchors", "sha", "defaultBranch", "devpage"].includes(k)));

// T5.2 "Done when": the prototype's edit flow on the fixture spec. Every edit
// runs through spectrace-core in the browser (WASM), and saving opens a PR.
test("the diagram editor renames, adds and deletes steps and arrows, edits requirements, undoes, and saves with a summary", async ({ page }) => {
  let saved: { source: string; summary: string[] } | null = null;
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/specs": [SUMMARY],
    "/api/projects/p1/specs/s1": SPEC,
    "/api/projects/p1/specs/s1/changes": (req: import("@playwright/test").Request) => {
      saved = req.postDataJSON() as typeof saved;
      return { status: 201, body: { number: 7, url: "https://github.com/acme/shop/pull/7", branch: "spectrace/spec-checkout-abc" } };
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/spec/s1");

  await page.getByRole("button", { name: "Edit diagram" }).click();
  await expect(page).toHaveURL(/edit=1/);
  await expect(page.getByRole("heading", { name: /Checkout\s+editing/ })).toBeVisible();
  const dia = page.getByRole("group", { name: "Checkout flow, editing" }).first();
  await expect(dia.locator(".pele-node")).toHaveCount(5);
  const inspector = page.getByRole("complementary", { name: "Edit step" });
  const save = page.getByRole("button", { name: /^Save/ });
  await expect(save).toBeDisabled();
  await expect(page.getByText("No spec changes yet.")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Rename a step: the node and its heading change, nothing else.
  await dia.getByRole("link", { name: "Declined" }).click();
  await expect(inspector.getByText("checkout.failed")).toBeVisible();
  await inspector.getByLabel("Label on the diagram").fill("Payment declined");
  await inspector.getByLabel("Label on the diagram").press("Enter");
  const diff = page.getByLabel("Spec diff");
  await expect(diff).toContainText("-   failed[Declined]");
  await expect(diff).toContainText("+   failed[Payment declined]");
  await expect(diff).toContainText("+ ## Payment declined {#checkout.failed}");
  await expect(save).toHaveText("Save · 1 change");
  await expect(dia.locator('.pele-node[data-id="failed"]')).toHaveAttribute("data-st", "new");

  // Edit a requirement line.
  await inspector.getByLabel("When, requirement r2").fill("a decline goes past the retry limit of 5");
  await inspector.getByLabel("When, requirement r2").press("Enter");
  await expect(diff).toContainText("+ - WHEN a decline goes past the retry limit of 5 THE SYSTEM SHALL cancel the order. {#r2}");
  await expect(save).toHaveText("Save · 2 changes");

  // Add a step after Paid, name it, and give it a requirement; then undo the requirement.
  await dia.getByRole("link", { name: "Paid" }).click();
  await page.getByRole("button", { name: "+ Step" }).click();
  await expect(dia.locator(".pele-node")).toHaveCount(6);
  await expect(inspector.getByText("checkout.step_1")).toBeVisible();
  await inspector.getByLabel("Label on the diagram").fill("Refunded");
  await inspector.getByLabel("Label on the diagram").press("Enter");
  await expect(diff).toContainText("+   paid -->|next| step_1");
  await expect(diff).toContainText("+ ## Refunded {#checkout.step_1}");
  await inspector.getByRole("button", { name: "+ Requirement" }).click();
  await expect(save).toHaveText("Save · 5 changes");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(save).toHaveText("Save · 4 changes");
  await expect(inspector.getByLabel("When, requirement r1")).toHaveCount(0);

  // Connect Refunded back to Cart, then rename the new arrow.
  await inspector.getByRole("button", { name: "+ Arrow from here" }).click();
  await expect(page.getByText("Connecting from")).toBeVisible();
  await dia.getByRole("link", { name: "Cart" }).click();
  await expect(diff).toContainText("+   step_1 -->|next| cart");
  await inspector.getByLabel("Arrow label to Cart").fill("reorder");
  await inspector.getByLabel("Arrow label to Cart").press("Enter");
  await expect(diff).toContainText("+   step_1 -->|reorder| cart");

  // Delete a step: its node, arrows and section go.
  await dia.getByRole("link", { name: "Details" }).click();
  await inspector.getByRole("button", { name: "Delete step" }).click();
  await expect(dia.locator(".pele-node")).toHaveCount(5);
  await expect(diff).toContainText("- ## Details {#checkout.details}");
  await expect(save).toHaveText("Save · 7 changes");
  await expectNoHorizontalScroll(page);

  // The change summary comes before anything is written.
  await save.click();
  const summary = page.getByRole("region", { name: "Change summary" });
  await expect(summary.getByRole("listitem")).toHaveText([
    "Renamed Declined to Payment declined",
    "Changed checkout.failed/r2: WHEN a decline goes past the retry limit of 5",
    "Added the step New step after Paid",
    "Renamed New step to Refunded",
    "Added an arrow from Refunded to Cart",
    "Relabelled the arrow Refunded → Cart to reorder",
    "Deleted the step Details",
  ]);
  expect(saved).toBeNull();
  await summary.getByRole("button", { name: "Open a pull request" }).click();
  const done = page.getByRole("region", { name: "Saved" });
  await expect(done.getByRole("link", { name: "#7" })).toHaveAttribute("href", "https://github.com/acme/shop/pull/7");
  expect(saved!.summary).toHaveLength(7);
  expect(saved!.source).toContain("  failed[Payment declined]");
  expect(saved!.source).not.toContain("details");
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page).not.toHaveURL(/edit=1/);
  expect(errors).toEqual([]);
});

test("Discard leaves the editor without saving", async ({ page }) => {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/specs": [SUMMARY],
    "/api/projects/p1/specs/s1": SPEC,
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  await page.goto("/spec/s1?edit=1");
  const inspector = page.getByRole("complementary", { name: "Edit step" });
  await inspector.getByLabel("Label on the diagram").fill("Basket");
  await inspector.getByLabel("Label on the diagram").press("Enter");
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveText("Save · 1 change");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page).not.toHaveURL(/edit=1/);
  await expect(page.getByText("Edits discarded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit diagram" })).toBeVisible();
});
