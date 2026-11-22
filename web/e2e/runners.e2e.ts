import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

// Runners: a user saves their own Anthropic API key, at both widths.
test("saves the user's own Anthropic API key", async ({ page }) => {
  let setup = { using: "server_key", keyHint: null as string | null, canSave: true };
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [{ id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x", repos: [] }],
    "/api/me/claude": (req) => {
      if (req.method() === "PUT") setup = { ...setup, using: "own_key", keyHint: "WXYZ" };
      return setup;
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);

  await page.goto("/runners");
  await expect(page.getByRole("heading", { name: "Your machines and sandboxes" })).toBeVisible();
  await page.getByLabel("Anthropic API key").fill("sk-ant-api03-abcdefghijklmnopqrstuvWXYZ");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(/ending in WXYZ/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
