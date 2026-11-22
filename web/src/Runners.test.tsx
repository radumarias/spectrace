import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeQueryClient } from "./api/queries";
import { App } from "./App";

const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };
type Setup = { using: string; keyHint: string | null; canSave: boolean };

/** A fake server holding one user's Claude setup. */
function fakeServer(setup: Setup) {
  const puts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(input, "http://x"), init);
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/api/me") return Response.json(USER);
      if (path === "/api/projects") return Response.json([{ id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x", repos: [] }]);
      if (path === "/api/me/claude" && req.method === "GET") return Response.json(setup);
      if (path === "/api/me/claude" && req.method === "PUT") {
        const { apiKey } = (await req.json()) as { apiKey: string };
        puts.push(apiKey);
        if (apiKey.startsWith("sk-ant-oat")) return Response.json({ error: { code: "bad_request", message: "That is a Claude subscription token." } }, { status: 400 });
        Object.assign(setup, { using: "own_key", keyHint: apiKey.slice(-4) });
        return Response.json(setup);
      }
      if (path === "/api/me/claude" && req.method === "DELETE") {
        Object.assign(setup, { using: "server_key", keyHint: null });
        return Response.json(setup);
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { puts };
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

it("saves the user's own API key, shows only its last four characters, and removes it", async () => {
  const user = userEvent.setup();
  const server = fakeServer({ using: "server_key", keyHint: null, canSave: true });
  at("/runners");
  expect(await screen.findByText(/this server's API key/)).toBeTruthy();
  await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-api03-abcdefghijklmnopqrstuvWXYZ");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByText(/ending in WXYZ/)).toBeTruthy();
  expect(server.puts).toEqual(["sk-ant-api03-abcdefghijklmnopqrstuvWXYZ"]);
  expect((screen.getByLabelText("Replace your Anthropic API key") as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(await screen.findByText(/this server's API key/)).toBeTruthy();
});

it("shows the server's refusal of a subscription token", async () => {
  const user = userEvent.setup();
  fakeServer({ using: "none", keyHint: null, canSave: true });
  at("/runners");
  await user.type(await screen.findByLabelText("Anthropic API key"), "sk-ant-oat01-whatever");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect((await screen.findByRole("alert")).textContent).toContain("subscription token");
});

it("shows the subscription without a key form for the owner", async () => {
  fakeServer({ using: "subscription", keyHint: null, canSave: true });
  at("/runners");
  expect(await screen.findByText(/Claude subscription, through Claude Code/)).toBeTruthy();
  expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
});
