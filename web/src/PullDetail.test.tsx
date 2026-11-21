import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };
const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const PULL = {
  id: "pr-1", repo: "acme/shop", number: 58, title: "Checkout: show decline reason inline", author: "ana", state: "open", draft: false,
  needsYou: true, headRef: "ana/decline-reason", baseRef: "main", htmlUrl: "https://github.com/acme/shop/pull/58",
  additions: 36, deletions: 6, changedFiles: 2, createdAt: "x", updatedAt: "x", mergedAt: null, syncedAt: "x",
  body: "The declined screen shows why the card was declined.", headSha: "abc",
  files: [
    { path: "src/checkout/Declined.tsx", status: "modified", previousPath: null, additions: 31, deletions: 6 },
    { path: "src/checkout/Declined.test.tsx", status: "added", previousPath: null, additions: 5, deletions: 0 },
  ],
};

function server(pull: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string) => {
      const path = new URL(input instanceof Request ? input.url : input, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/projects") return Response.json([PROJECT]);
      if (path === "/api/projects/p1/pulls/pr-1") return Response.json(pull, { status });
      return new Response(null, { status: 404 });
    }),
  );
}

const at = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => localStorage.setItem("spectrace-proj", "p1"));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("shows the header, the description, and the files", async () => {
  server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  expect(await screen.findByRole("heading", { name: PULL.title })).toBeTruthy();
  expect(screen.getByText("checks not synced yet")).toBeTruthy();
  expect(screen.getByText(PULL.body)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Merge PR" }) as HTMLButtonElement).disabled).toBe(true);

  await user.click(screen.getByRole("tab", { name: "Files · 2" }));
  const table = screen.getByRole("table");
  expect(within(table).getByText("src/checkout/Declined.tsx")).toBeTruthy();
  expect(within(table).getByText("+31")).toBeTruthy();
  expect(within(table).getByText("added")).toBeTruthy();
});

it("says so when the pull request is not in the project", async () => {
  server({ error: { code: "not_found", message: "x" } }, 404);
  at("/pr/pr-1");
  expect(await screen.findByText("This pull request is not in Shop app.")).toBeTruthy();
});
