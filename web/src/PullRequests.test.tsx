import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { ago } from "./pages/PullRequests";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };
const repo = (id: string, full_name: string) => ({ id, github_repo_id: null, full_name, default_branch: "main", index_state: "ready" });
const PROJECT = { id: "p1", name: "Shop", context: "", created_at: "2026-11-21T10:00:00Z", updated_at: "2026-11-21T10:00:00Z", repos: [repo("r1", "acme/shop"), repo("r2", "acme/api")] };
const pull = (id: string, repoName: string, number: number, title: string, o: Record<string, unknown> = {}) => ({
  id, repo: repoName, number, title, author: "ana", state: "open", draft: false, needsYou: true, headRef: "feat", baseRef: "main",
  htmlUrl: "https://github.com/x", additions: 10, deletions: 2, changedFiles: 3,
  createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T10:00:00Z", mergedAt: null, syncedAt: "2026-11-21T10:00:00Z", ...o,
});
const ALL = [
  pull("a", "acme/shop", 142, "Add refunds to checkout"),
  pull("b", "acme/api", 7, "Retry limit for declines", { draft: true, needsYou: false }),
  pull("c", "acme/shop", 140, "Fix cart total", { state: "merged", needsYou: false, mergedAt: "2026-11-20T10:00:00Z" }),
];
const COUNTS = { needs: 1, open: 2, merged: 1 };

function fakeServer() {
  const queries: string[] = [];
  let syncs = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/me") return Response.json(USER);
      if (url.pathname === "/api/projects") return Response.json([PROJECT]);
      if (url.pathname === "/api/projects/p1/pulls/sync") {
        syncs++;
        return Response.json({ id: "j1" }, { status: 202 });
      }
      if (url.pathname === "/api/projects/p1/pulls") {
        queries.push(url.search);
        const f = url.searchParams.get("filter");
        const r = url.searchParams.get("repo");
        const pulls = ALL.filter((p) => (f === "needs" ? p.needsYou : f === "open" ? p.state === "open" : p.state === "merged") && (!r || p.repo === r));
        return Response.json({ pulls, counts: COUNTS });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { queries, syncs: () => syncs };
}

const at = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => localStorage.setItem("spectrace-proj", "p1"));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("lists the needs-you tab first, then switches tabs and repos through the API", async () => {
  const user = userEvent.setup();
  const server = fakeServer();
  at("/prs");

  expect(await screen.findByRole("heading", { name: "1 pull request needs you" })).toBeTruthy();
  const row = await screen.findByRole("link", { name: /Add refunds to checkout/ });
  expect(row.getAttribute("href")).toBe("/pr/a");
  expect(screen.getByText(/acme\/shop #142 · ana/)).toBeTruthy();
  expect(screen.queryByText("Retry limit for declines")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Open · 2" }));
  expect(await screen.findByText("Retry limit for declines")).toBeTruthy();
  expect(screen.getByText("draft")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Merged · 1" }));
  expect(await screen.findByText("Fix cart total")).toBeTruthy();
  expect(screen.getByText("merged")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Open · 2" }));
  await user.click(screen.getByRole("button", { name: "api" }));
  await waitFor(() => expect(screen.queryByText("Add refunds to checkout")).toBeNull());
  expect(screen.getByText("Retry limit for declines")).toBeTruthy();
  expect(server.queries).toContain("?filter=open&repo=acme%2Fapi");
});

it("pulls from GitHub", async () => {
  const user = userEvent.setup();
  const server = fakeServer();
  at("/prs");
  await user.click(await screen.findByRole("button", { name: "Pull from GitHub" }));
  expect(await screen.findByText("Pulling from GitHub…")).toBeTruthy();
  expect(server.syncs()).toBe(1);
});

it("formats ages", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  expect(ago("2026-11-21T11:59:40Z", now)).toBe("just now");
  expect(ago("2026-11-21T11:57:00Z", now)).toBe("3 min ago");
  expect(ago("2026-11-21T09:00:00Z", now)).toBe("3 h ago");
  expect(ago("2026-11-16T12:00:00Z", now)).toBe("5 d ago");
});
