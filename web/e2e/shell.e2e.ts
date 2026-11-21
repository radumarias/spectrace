import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

// The app shell loads at both widths: the signed-in Projects page, no horizontal scroll,
// and no console errors.
test("the signed-in shell loads cleanly", async ({ page }) => {
  await mockApi(page, { "/api/me": USER, "/api/projects": [] });
  const errors = trackErrors(page);

  await page.goto("/projects");

  await expect(page.getByRole("heading", { name: "All your projects" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("the sign-in page loads without a session", async ({ page }) => {
  await mockApi(page, {
    "/api/me": { status: 401, body: { error: { code: "unauthorized", message: "not signed in" } } },
  });
  // A 401 from /api/me is the expected answer here, so it is the only error we allow.
  const errors = trackErrors(page);

  await page.goto("/projects");

  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});
