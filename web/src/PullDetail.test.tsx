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

/** A fake server that remembers reviews and merges, so the page sees its own writes. */
function server(pull: Record<string, unknown>, status = 200, refuseMerge = false) {
  const state = { ...pull };
  const reviews: { id: number; verdict: string; body: string; headSha: string; githubReviewId: number; createdAt: string }[] = [];
  const posted: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/projects") return Response.json([PROJECT]);
      if (path === "/api/projects/p1/pulls/pr-1") return Response.json(state, { status });
      if (path === "/api/projects/p1/pulls/pr-1/reviews" && req.method === "GET") return Response.json({ reviews });
      if (path === "/api/projects/p1/pulls/pr-1/reviews") {
        const body = (await req.json()) as { verdict: string; body?: string };
        posted.push({ path, body });
        const r = { id: reviews.length + 1, verdict: body.verdict === "approve" ? "approved" : "changes_requested", body: body.body ?? "", headSha: "abc", githubReviewId: 1, createdAt: "x" };
        reviews.unshift(r);
        return Response.json(r, { status: 201 });
      }
      if (path === "/api/projects/p1/pulls/pr-1/merge") {
        posted.push({ path, body: null });
        if (refuseMerge) return Response.json({ error: { code: "conflict", message: "conflict: head moved" } }, { status: 409 });
        state.state = "merged";
        return Response.json(state);
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { posted };
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

it("approves, and the button shows it", async () => {
  const s = server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("button", { name: "✓ Approved" })).toBeTruthy();
  expect(s.posted).toEqual([{ path: "/api/projects/p1/pulls/pr-1/reviews", body: { verdict: "approve" } }]);
});

it("asks for a note before requesting changes", async () => {
  const s = server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("button", { name: "Request changes" }));
  const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await user.type(screen.getByLabelText("What should change?"), "Map the gateway codes.");
  await user.click(send);
  expect(await screen.findByText("You asked for changes on this commit")).toBeTruthy();
  expect(s.posted[0]?.body).toEqual({ verdict: "request_changes", body: "Map the gateway codes." });
});

it("merges, and shows the merged state", async () => {
  const s = server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("button", { name: "Merge PR" }));
  expect(await screen.findByRole("button", { name: "Merged" })).toBeTruthy();
  expect(s.posted.at(-1)?.path).toBe("/api/projects/p1/pulls/pr-1/merge");
});

it("shows why a merge was refused", async () => {
  server(PULL, 200, true);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("button", { name: "Merge PR" }));
  expect((await screen.findByRole("alert")).textContent).toContain("head moved");
  expect((screen.getByRole("button", { name: "Merge PR" }) as HTMLButtonElement).disabled).toBe(false);
});
