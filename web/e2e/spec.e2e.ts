import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
// fixtures/shop as the T4.4 index serves it (GET /api/projects/{id}/specs/{specId}), produced from the real parser and scanner.
import SPEC from "./spec-checkout.json" with { type: "json" };

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const SUMMARY = Object.fromEntries(Object.entries(SPEC).filter(([k]) => !["source", "model", "diagnostics", "anchors", "sha", "defaultBranch", "devpage"].includes(k)));
const DOC = "24d057aa-88d5-40ca-b306-f1e9ca3148f3";

async function open(page: import("@playwright/test").Page, spec: object = SPEC) {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/specs": [SUMMARY],
    "/api/projects/p1/specs/s1": spec,
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
}

// T4.5 "Done when": open the fixture spec, select a step, zoom, and enter full screen (here at both widths, phone included).
test("the spec page draws the flow, selects a step from the diagram, zooms and goes full screen", async ({ page }) => {
  await open(page);
  const errors = trackErrors(page);
  await page.goto("/spec");

  // One spec in the project: /spec opens it.
  await expect(page).toHaveURL(/\/spec\/s1/);
  await expect(page.getByRole("heading", { name: "Checkout", level: 1 })).toBeVisible();
  const dia = page.getByRole("group", { name: "Checkout flow" }).first();
  await expect(dia.locator(".pele-node")).toHaveCount(5);
  // Details has no tests in the fixture, so it is the step that opens first.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(inspector.getByText("no tests", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The node's `click pay href "spec://checkout.pay"` line is its action: it selects the step and never navigates.
  await dia.getByRole("link", { name: "Pay" }).click();
  await expect(page).toHaveURL(/step=pay/);
  await expect(inspector.getByRole("heading", { name: "Pay" })).toBeVisible();
  await expect(inspector.getByText("tested", { exact: true })).toBeVisible();
  await expect(inspector.getByText("charges_once")).toBeVisible();
  await expect(dia.locator('.pele-node[data-id="pay"]')).toHaveClass(/sel/);

  const zoom = page.getByRole("group", { name: "Zoom diagram" }).first();
  await expect(zoom.getByText("100%")).toBeVisible();
  await zoom.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom.getByText("125%")).toBeVisible();
  await zoom.getByRole("button", { name: "Fit diagram" }).click();
  await expect(zoom.getByText("100%")).toBeVisible();

  await page.getByRole("button", { name: "Show Checkout flow full screen" }).click();
  const fs = page.getByRole("dialog", { name: "Checkout flow" });
  await expect(fs).toBeVisible();
  await expect(fs.locator(".pele-node")).toHaveCount(5);
  await fs.getByRole("button", { name: "Zoom in" }).click();
  await expect(fs.getByText("125%")).toBeVisible();
  await fs.getByRole("button", { name: "Fit diagram" }).click();
  // Selecting in full screen updates the footer.
  await fs.getByRole("link", { name: "Declined" }).click();
  await expect(fs.locator(".fs-sum").getByText("checkout.failed")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(fs).toBeHidden();
  await expect(inspector.getByRole("heading", { name: "Declined payment" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the Markdown tab renders the spec with requirement status, and Code + tests shows the anchored code", async ({ page }) => {
  await open(page);
  const errors = trackErrors(page);
  await page.goto("/spec/s1?step=failed");

  await page.getByRole("tab", { name: "Markdown" }).click();
  // No devpage server in this project's answers: spectrace renders the spec itself.
  await expect(page.getByText("spec/checkout.md · rendered by spectrace, devpage is off here")).toBeVisible();
  await expect(page.locator(".md-req").filter({ hasText: "cancel the order" })).toContainText("THE SYSTEM SHALL");
  await expect(page.locator(".md-req")).toHaveCount(9);
  await expect(page.locator(".md-req").filter({ hasText: "no test" })).toHaveCount(2);
  await expect(page.locator(".spec-md .md-flow").filter({ hasText: "card testing" })).toContainText("flow · checkout.failed");
  // A heading is the step: clicking it selects it.
  await page.getByRole("button", { name: /Paid/ }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" }).getByRole("heading", { name: "Paid" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("tab", { name: "Code + tests" }).click();
  await expect(page.getByText("src/checkout.rs:", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("outbox::push(Email::Receipt(o.id));")).toBeVisible();
  await expect(page.getByText("fn receipt_sent_from_outbox() {}")).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("with devpage server running, the Markdown tab shows its page, and Requirement status shows spectrace's", async ({ page }) => {
  await open(page, { ...SPEC, devpage: { id: DOC, version: 2, url: `/d/${DOC}/` } });
  // devpage server's page, as the Worker proxies it on this origin.
  await page.route(`**/d/${DOC}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Checkout</title><h1>Checkout</h1><p>WHEN the user pays THE SYSTEM SHALL charge the card exactly once.</p>" }),
  );
  const errors = trackErrors(page);
  await page.goto("/spec/s1?tab=md");

  await expect(page.getByText("spec/checkout.md · rendered by devpage · version 2")).toBeVisible();
  const frame = page.frameLocator("iframe.devpage-frame");
  await expect(frame.getByRole("heading", { name: "Checkout" })).toBeVisible();
  await expect(frame.getByText("charge the card exactly once")).toBeVisible();
  await expect(page.getByRole("button", { name: "devpage" })).toHaveAttribute("aria-pressed", "true");
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Requirement status" }).click();
  await expect(page).toHaveURL(/md=status/);
  await expect(page.locator("iframe.devpage-frame")).toHaveCount(0);
  await expect(page.locator(".md-req")).toHaveCount(9);
  await page.getByRole("button", { name: "devpage" }).click();
  await expect(page.locator("iframe.devpage-frame")).toBeVisible();
  expect(errors).toEqual([]);
});
