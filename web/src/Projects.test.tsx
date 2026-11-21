import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };
const GITHUB = [
  { id: 11, full_name: "acme/mobile", default_branch: "trunk" },
  { id: 12, full_name: "acme/mobile-api", default_branch: "main" },
  { id: 13, full_name: "acme/website", default_branch: "main" },
];

type Stored = { id: string; name: string; context: string; created_at: string; updated_at: string; repos: unknown[] };

/** A fake server for sign-in, projects and the GitHub repo list. `github` null means the App is not installed (404). */
function fakeServer(opts: { github: unknown[] | null; projects?: Stored[] }) {
  const projects: Stored[] = opts.projects ?? [];
  const posted: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/github/repos") return opts.github ? Response.json(opts.github) : new Response(null, { status: 404 });
      if (path === "/api/projects" && req.method === "GET") return Response.json(projects);
      if (path === "/api/projects" && req.method === "POST") {
        const body = (await req.json()) as { name: string; context?: string; repos: { full_name: string; github_repo_id?: number; default_branch?: string }[] };
        posted.push(body);
        const p: Stored = {
          id: "p1",
          name: body.name,
          context: body.context ?? "",
          created_at: "2026-11-21T16:00:00Z",
          updated_at: "2026-11-21T16:00:00Z",
          repos: body.repos.map((r, i) => ({
            id: `r${i}`,
            github_repo_id: r.github_repo_id ?? null,
            full_name: r.full_name,
            default_branch: r.default_branch ?? "main",
            index_state: "pending",
          })),
        };
        projects.push(p);
        return Response.json(p, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { posted };
}

const at = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates a project with two repos (one suggested, one typed as a link) and lands on its Home", async () => {
  const user = userEvent.setup();
  const server = fakeServer({ github: GITHUB });
  at("/projects");

  await user.click(await screen.findByRole("link", { name: "+ New project" }));
  expect(await screen.findByRole("heading", { name: "New project" })).toBeTruthy();
  const create = screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);

  await user.type(screen.getByLabelText("Name"), "Mobile app");
  expect(create.disabled).toBe(true); // still no repo

  await user.click(await screen.findByRole("button", { name: "+ acme/mobile" }));
  await user.type(screen.getByLabelText("Repositories"), "https://github.com/acme/infra.git{Enter}");
  expect(screen.getByRole("button", { name: "Remove acme/mobile" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove acme/infra" })).toBeTruthy();
  await user.type(screen.getByLabelText("Context"), "  Payments are critical.  ");
  expect(create.disabled).toBe(false);
  await user.click(create);

  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  expect(screen.getByText("Mobile app · 2 repos")).toBeTruthy();
  expect(server.posted).toEqual([
    {
      name: "Mobile app",
      context: "Payments are critical.",
      repos: [{ full_name: "acme/mobile", github_repo_id: 11, default_branch: "trunk" }, { full_name: "acme/infra" }],
    },
  ]);
});

it("rejects bad and duplicate repos and lets one be removed", async () => {
  const user = userEvent.setup();
  fakeServer({ github: null });
  at("/new-project");
  const repo = await screen.findByLabelText("Repositories");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Type a repo first, like owner/repo.");
  await user.type(repo, "nonsense{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("That does not look like owner/repo.");
  await user.clear(repo);
  await user.type(repo, "a/b{Enter}a/b{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("a/b is already in this project.");
  await user.click(screen.getByRole("button", { name: "Remove a/b" }));
  expect(screen.getByText("No repos yet. Add at least one.")).toBeTruthy();
  expect(screen.queryByText("From your GitHub:")).toBeNull(); // no GitHub App, no suggestions
});

it("lists projects as cards and opens one on its Home", async () => {
  const user = userEvent.setup();
  fakeServer({
    github: [],
    projects: [
      {
        id: "p9",
        name: "Shop app",
        context: "Web shop.",
        created_at: "x",
        updated_at: "x",
        repos: ["a/1", "a/2", "a/3", "a/4"].map((n, i) => ({ id: `r${i}`, github_repo_id: null, full_name: n, default_branch: "main", index_state: i ? "ready" : "indexing" })),
      },
    ],
  });
  at("/projects");
  const card = await screen.findByRole("button", { name: "Open Shop app" });
  expect(card.textContent).toContain("4 repos");
  expect(card.textContent).toContain("+1");
  expect(card.textContent).toContain("Indexing · 3 of 4 repos ready");
  await user.click(card);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Shop app · 4 repos")).toBeTruthy());
});

it("shows the server's message when creating fails", async () => {
  const user = userEvent.setup();
  fakeServer({ github: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      const path = new URL(input.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/projects" && input.method === "POST")
        return Response.json({ error: { code: "bad_request", message: "project name is required" } }, { status: 400 });
      return Response.json([]);
    }),
  );
  at("/new-project");
  await user.type(await screen.findByLabelText("Name"), "X");
  await user.type(screen.getByLabelText("Repositories"), "a/b{Enter}");
  await user.click(screen.getByRole("button", { name: "Create project" }));
  expect((await screen.findByRole("alert")).textContent).toBe("project name is required");
});
