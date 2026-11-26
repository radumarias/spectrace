import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostsOf, makeQueryClient } from "./api/queries";
import { App } from "./App";
import { gitlabRepoOf } from "./ui/RepoField";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };
const repo = (full_name: string, provider = "github") => ({ id: `r-${full_name}`, provider, github_repo_id: null, full_name, default_branch: "main", index_state: "ready", languages: {}, file_count: 1, tree_truncated: false, indexed_at: null, index_error: null });

function fakeServer() {
  let account: { username: string; kind: string } | null = null;
  const project = { id: "p1", name: "Shop", context: "", created_at: "x", updated_at: "x", repos: [repo("acme/shop")] };
  const patches: { repos?: { full_name: string; provider?: string }[] }[] = [];
  const tokens: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/github/repos") return Response.json([]);
      if (path === "/api/gitlab" && req.method === "GET") return Response.json({ configured: true, url: "https://gitlab.test", oauth: true, account });
      if (path === "/api/gitlab/token") {
        const { token } = (await req.json()) as { token: string };
        tokens.push(token);
        account = { username: "radu", kind: "token" };
        return Response.json({ configured: true, url: "https://gitlab.test", oauth: true, account });
      }
      if (path === "/api/gitlab/repos") {
        return Response.json(account ? [{ id: 77, full_name: "group/sub/shop", name: "shop", default_branch: "main", private: true, html_url: "https://gitlab.test/group/sub/shop" }] : []);
      }
      if (path === "/api/projects") return Response.json([project]);
      if (path === "/api/projects/p1" && req.method === "PATCH") {
        const body = (await req.json()) as (typeof patches)[number];
        patches.push(body);
        if (body.repos) project.repos = body.repos.map((r) => repo(r.full_name, r.provider ?? "github"));
        return Response.json(project);
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { patches, tokens };
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

it("connects GitLab with a token and adds a GitLab repo", async () => {
  const user = userEvent.setup();
  const server = fakeServer();
  at("/project");
  expect((await screen.findByRole("link", { name: "Connect GitLab" })).getAttribute("href")).toBe("/api/gitlab/connect");
  await user.click(screen.getByRole("button", { name: "Use a personal access token instead" }));
  await user.type(screen.getByLabelText("Personal access token"), "glpat-abc");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("@radu")).toBeTruthy();
  expect(server.tokens).toEqual(["glpat-abc"]);
  await user.click(await screen.findByRole("button", { name: "+ group/sub/shop" }));
  await waitFor(() => expect(server.patches.at(-1)?.repos).toEqual([
    { full_name: "acme/shop", provider: "github", default_branch: "main" },
    { full_name: "group/sub/shop", provider: "gitlab", default_branch: "main" },
  ]));
});

it("reads GitLab links and names the hosts of a project", () => {
  expect(gitlabRepoOf("https://gitlab.test/group/sub/shop/-/merge_requests/3", "https://gitlab.test")).toBe("group/sub/shop");
  expect(gitlabRepoOf("https://github.com/acme/shop", "https://gitlab.test")).toBeNull();
  expect(hostsOf({ repos: [repo("a/b")] as never })).toBe("GitHub");
  expect(hostsOf({ repos: [repo("a/b"), repo("g/c", "gitlab")] as never })).toBe("GitHub and GitLab");
  expect(hostsOf({ repos: [repo("g/c", "gitlab")] as never })).toBe("GitLab");
});
