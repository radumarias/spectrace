import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import SPEC from "./spec-checkout.json" with { type: "json" };

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const base = { repo: "acme/shop", root: "", errors: 0, edges: [], indexedAt: "2026-11-21T18:00:00Z" };
// Two areas: storefront (checkout from fixtures/shop, and cart) and orders (a spec with an error).
const SPECS = [
  { ...base, id: "s1", path: "spec/storefront/checkout.md", area: "storefront", flow: "checkout", title: "Checkout", steps: 5, requirements: 9, tested: 7 },
  { ...base, id: "s2", path: "spec/storefront/cart.md", area: "storefront", flow: "cart", title: "Cart", steps: 2, requirements: 3, tested: 3 },
  { ...base, id: "s3", path: "spec/orders/refunds.md", area: "orders", flow: "refunds", title: "refunds", steps: 0, requirements: 0, tested: 0, errors: 1 },
];

// T6.5 "Done when": the fixture with two areas draws both, and drilling in reaches the spec.
test("the app map draws the areas, rolls them up, and drills down to a spec", async ({ page }) => {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/specs": SPECS,
    "/api/projects/p1/specs/s1": { ...SPEC, path: "spec/storefront/checkout.md", area: "storefront" },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/map");

  await expect(page.getByRole("heading", { name: "Shop app", level: 1 })).toBeVisible();
  const map = page.getByRole("group", { name: "Shop app map" });
  await expect(map.locator(".pele-node")).toHaveCount(3);
  await expect(map.locator('.pele-node[data-st="bad"]')).toContainText("Orders");
  const rollup = page.getByRole("complementary", { name: "Roll-up" });
  await expect(rollup.getByText("spec errors")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The node's click line is a mermaid action (action:step) that selects it.
  await map.getByRole("link", { name: /Storefront/ }).click();
  await expect(rollup.getByRole("heading", { name: "Storefront" })).toBeVisible();
  await expect(rollup.getByText("83% · req 10/12")).toBeVisible();
  await rollup.getByRole("button", { name: "Zoom into Storefront" }).click();

  await expect(page.getByRole("heading", { name: "Storefront", level: 1 })).toBeVisible();
  const area = page.getByRole("group", { name: "Storefront map" });
  await expect(area.locator(".pele-node")).toHaveCount(3);
  await area.getByRole("link", { name: /Checkout/ }).click();
  await rollup.getByRole("button", { name: "Open the Checkout spec" }).click();
  await expect(page).toHaveURL(/\/spec\/s1/);
  await expect(page.getByRole("heading", { name: "Checkout", level: 1 })).toBeVisible();

  // Back up through the crumbs.
  await page.goBack();
  await page.getByRole("navigation", { name: "Map level" }).getByRole("button", { name: "Shop app" }).click();
  await expect(page.getByRole("group", { name: "Shop app map" })).toBeVisible();
  expect(errors).toEqual([]);
});
