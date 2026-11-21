import { expect, test } from "./fixtures";

// No mocks here: this proves the Worker itself runs under `vite dev`, next to the SPA.
test("the real Worker answers /api/health", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
});
