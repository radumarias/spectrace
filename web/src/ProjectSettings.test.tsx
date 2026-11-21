import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };

type Repo = { id: string; github_repo_id: number | null; full_name: string; default_branch: string; index_state: string };
type Stored = { id: string; name: string; context: string; created_at: string; updated_at: string; repos: Repo[] };

const repo = (full_name: string, index_state = "ready"): Repo => ({ id: `r-${full_name}`, github_repo_id: null, full_name, default_branch: "main", index_state });

/** A fake server that keeps its projects, so a "reload" (a new app on the same server) sees what was saved. */
function fakeServer(projects: Stored[]) {
  const patches: unknown[] = [];
  const reindexed: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/github/repos") return new Response(null, { status: 404 });
      if (path === "/api/projects") return Response.json(projects);
      const m = /^\/api\/projects\/([^/]+)$/.exec(path);
      const found = m ? projects.find((p) => p.id === m[1]) : undefined;
      if (found && req.method === "PATCH") {
        const body = (await req.json()) as { name?: string; context?: string; repos?: { full_name: string }[] };
        patches.push(body);
        if (body.name !== undefined) found.name = body.name;
        if (body.context !== undefined) found.context = body.context;
        if (body.repos) found.repos = body.repos.map((r) => found.repos.find((x) => x.full_name === r.full_name) ?? repo(r.full_name, "pending"));
        return Response.json(found);
      }
      const re = /^\/api\/projects\/([^/]+)\/reindex$/.exec(path);
      const target = re ? projects.find((p) => p.id === re[1]) : undefined;
      if (target && req.method === "POST") {
        reindexed.push(target.id);
        target.repos.forEach((r) => (r.index_state = "pending"));
        return Response.json(target);
      }
      if (found && req.method === "DELETE") {
        projects.splice(projects.indexOf(found), 1);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { patches, reindexed };
}

const at = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const shop = (): Stored => ({ id: "p1", name: "Shop app", context: "Web shop.", created_at: "x", updated_at: "x", repos: [repo("acme/shop"), repo("acme/api")] });

beforeEach(() => localStorage.setItem("spectrace-proj", "p1"));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("edits the context, reloads, and sees it saved", async () => {
  const user = userEvent.setup();
  const server = fakeServer([shop()]);
  const first = at("/project");
  const ctx = (await screen.findByLabelText("Context")) as HTMLTextAreaElement;
  expect(ctx.value).toBe("Web shop.");
  await user.clear(ctx);
  await user.type(ctx, "Payments are critical.");
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(server.patches.at(-1)).toEqual({ context: "Payments are critical." });

  first.unmount(); // a reload: a fresh app, same server
  at("/project");
  expect(((await screen.findByLabelText("Context")) as HTMLTextAreaElement).value).toBe("Payments are critical.");
});

it("renames the project and refuses an empty name", async () => {
  const user = userEvent.setup();
  const server = fakeServer([shop()]);
  at("/project");
  const name = await screen.findByLabelText("Name");
  await user.clear(name);
  expect(screen.getByText("Give the project a name.")).toBeTruthy();
  await user.type(name, "Store");
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(server.patches).toEqual([{ name: "Store" }]);
  expect(screen.getByRole("heading", { name: "Store" })).toBeTruthy();
});

it("adds and removes repos, saving each change at once", async () => {
  const user = userEvent.setup();
  const server = fakeServer([shop()]);
  at("/project");
  await user.type(await screen.findByLabelText("Repositories"), "acme/web{Enter}");
  await waitFor(() => expect(server.patches.length).toBe(1));
  expect(server.patches[0]).toEqual({
    repos: [
      { full_name: "acme/shop", default_branch: "main" },
      { full_name: "acme/api", default_branch: "main" },
      { full_name: "acme/web" },
    ],
  });
  expect(await screen.findByText(/Indexing · 2 of 3 repos ready/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove acme/api" }));
  await waitFor(() => expect(server.patches.length).toBe(2));
  expect((server.patches[1] as { repos: unknown[] }).repos).toHaveLength(2);
});

it("removes the project only after a confirm step", async () => {
  const user = userEvent.setup();
  const projects = [shop()];
  fakeServer(projects);
  at("/project");
  await user.click(await screen.findByRole("button", { name: "Remove project" }));
  await user.click(screen.getByRole("button", { name: "Keep it" }));
  expect(projects).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Remove project" }));
  await user.click(screen.getByRole("button", { name: "Yes, remove" }));
  expect(await screen.findByRole("heading", { name: "All your projects" })).toBeTruthy();
  expect(projects).toHaveLength(0);
  expect(localStorage.getItem("spectrace-proj")).toBeNull();
});

/** A WebSocket the test can push events through. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  seq = 0;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  push(event: string) {
    this.onmessage?.({ data: JSON.stringify({ id: ++this.seq, projectId: "p1", jobId: "j", event, data: {}, createdAt: "x" }) });
  }
}

it("re-index queues the job, shows the banner, and ends in indexed from live events", async () => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const user = userEvent.setup();
  const projects = [shop()];
  const server = fakeServer(projects);
  at("/project");
  const button = (await screen.findByRole("button", { name: "Re-index repos" })) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(FakeSocket.all).toHaveLength(0); // nothing is indexing, so nothing to listen to
  await user.click(button);
  expect(server.reindexed).toEqual(["p1"]);
  expect(await screen.findByText(/Indexing · 0 of 2 repos ready/)).toBeTruthy();
  expect(((await screen.findByRole("button", { name: "Indexing…" })) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  expect(FakeSocket.all[0]!.url).toBe("ws://localhost:3000/api/projects/p1/events".replace("localhost:3000", location.host));

  // The Worker finishes the first repo and says so.
  projects[0]!.repos[0]!.index_state = "ready";
  FakeSocket.all[0]!.push("succeeded");
  expect(await screen.findByText(/Indexing · 1 of 2 repos ready/)).toBeTruthy();

  projects[0]!.repos[1]!.index_state = "ready";
  FakeSocket.all[0]!.push("succeeded");
  expect(await screen.findByRole("button", { name: "Re-index repos" })).toBeTruthy();
  expect(screen.queryByText(/Indexing · /)).toBeNull();
  await waitFor(() => expect(FakeSocket.all[0]!.closed).toBe(true));
});

it("a project that is already indexing updates its card on the Projects page", async () => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const projects = [{ ...shop(), repos: [repo("acme/shop", "indexing")] }];
  fakeServer(projects);
  at("/projects");
  expect(await screen.findByText(/Indexing · 0 of 1 repos ready/)).toBeTruthy();
  projects[0]!.repos[0]!.index_state = "ready";
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  FakeSocket.all[0]!.push("succeeded");
  expect(await screen.findByText("indexed")).toBeTruthy();
});

it("shows project Home with an indexing banner, context and repo count", async () => {
  fakeServer([{ ...shop(), repos: [repo("acme/shop"), repo("acme/api", "indexing")] }]);
  at("/home");
  expect(await screen.findByRole("heading", { name: "Setting up Shop app" })).toBeTruthy();
  expect(screen.getByText(/Indexing · 1 of 2 repos ready/)).toBeTruthy();
  expect(screen.getByText("Web shop.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Edit context and repos" })).toBeTruthy();
});
