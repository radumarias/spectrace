import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat.png" };

/** Fake the server: `/api/me` answers with `user`, or 401 when `user` is null. */
function fakeServer(user: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      if (new URL(req.url, "http://x").pathname === "/api/me") {
        return user
          ? Response.json(user)
          : Response.json({ error: { code: "unauthorized", message: "not signed in" } }, { status: 401 });
      }
      if (new URL(req.url, "http://x").pathname === "/api/projects") return Response.json([]);
      return new Response(null, { status: 404 });
    }),
  );
}

const at = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

it("shows the sign-in page without a session", async () => {
  fakeServer(null);
  at("/projects");
  const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
  expect(link.getAttribute("href")).toBe("/api/auth/github/login");
  expect(screen.queryByRole("heading", { name: "All your projects" })).toBeNull();
});

it("shows the signed-in user's avatar from /api/me", async () => {
  fakeServer(USER);
  at("/projects");
  const avatar = await screen.findByRole("button", { name: /Signed in as octocat/ });
  expect(avatar.querySelector("img")?.getAttribute("src")).toBe(USER.avatar_url);
});

it("shows the root page without a sidebar", async () => {
  fakeServer(USER);
  at("/projects");
  expect(await screen.findByRole("heading", { name: "All your projects" })).toBeTruthy();
  expect(screen.queryByText("Quality")).toBeNull();
});

it("shows the sidebar and tab bar inside a project", async () => {
  fakeServer(USER);
  at("/agents");
  expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  expect(screen.getByText("Quality")).toBeTruthy();
  expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(2);
});
