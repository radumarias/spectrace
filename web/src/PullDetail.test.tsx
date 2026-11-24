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
/** The server's gates, from a short list of what is open. */
const gates = (open: string[] = []) =>
  [["review", "Agent review finished"], ["findings", "No open high or medium findings"], ["mapping", "Every changed file mapped to a spec"], ["tests", "Tests pass"], ["approval", "Your approval · 1/1"]].map(([id, label]) => ({
    id, label, status: id === "mapping" ? "unchecked" : open.includes(id!) ? "open" : "pass",
  }));

const PULL = {
  id: "pr-1", repo: "acme/shop", number: 58, title: "Checkout: show decline reason inline", author: "ana", state: "open", draft: false,
  needsYou: true, testsTotal: 0, testsPassed: 0, testsFailed: 0, headRef: "ana/decline-reason", baseRef: "main", htmlUrl: "https://github.com/acme/shop/pull/58",
  additions: 36, deletions: 6, changedFiles: 2, createdAt: "x", updatedAt: "x", mergedAt: null, syncedAt: "x",
  body: "The declined screen shows why the card was declined.", headSha: "abc", checks: [], checksState: "none", gates: gates(),
  files: [
    { path: "src/checkout/Declined.tsx", status: "modified", previousPath: null, additions: 31, deletions: 6 },
    { path: "src/checkout/Declined.test.tsx", status: "added", previousPath: null, additions: 5, deletions: 0 },
  ],
};

const DIFF = {
  files: [
    { path: "src/checkout/Declined.tsx", patch: "@@ -10,3 +10,4 @@ export function Declined() {\n   const reason = useReason();\n-  return <p>Declined</p>;\n+  return <p>Declined: {reason}</p>;\n+  // shown inline\n }" },
    { path: "src/checkout/Declined.test.tsx", patch: null },
  ],
};

/** A fake server that remembers reviews and merges, so the page sees its own writes. */
function server(pull: Record<string, unknown>, status = 200, refuseMerge = false, agentReview: Record<string, unknown> | null = null) {
  const state = { ...pull };
  let review = agentReview;
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
      if (path === "/api/projects/p1/pulls/pr-1/diff") return Response.json(DIFF);
      if (path === "/api/projects/p1/pulls/pr-1/reviews" && req.method === "GET") return Response.json({ reviews });
      if (path === "/api/projects/p1/pulls/pr-1/reviews") {
        const body = (await req.json()) as { verdict: string; body?: string };
        posted.push({ path, body });
        const r = { id: reviews.length + 1, verdict: body.verdict === "approve" ? "approved" : "changes_requested", body: body.body ?? "", headSha: "abc", githubReviewId: 1, createdAt: "x" };
        reviews.unshift(r);
        return Response.json(r, { status: 201 });
      }
      if (path === "/api/projects/p1/pulls/pr-1/agent-review" && req.method === "GET") return Response.json({ review });
      if (path === "/api/projects/p1/pulls/pr-1/agent-review") {
        posted.push({ path, body: null });
        review = { ...REVIEW, state: "queued", stage: "queued", findings: [], dropped: 0, walkthrough: "" };
        return Response.json({ review }, { status: 202 });
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
  expect(screen.getByText("no checks")).toBeTruthy();
  expect(screen.getByText(PULL.body)).toBeTruthy();

  await user.click(screen.getByRole("tab", { name: "Files · 2" }));
  expect(screen.getByText("src/checkout/Declined.tsx")).toBeTruthy();
  expect(screen.getByText("+31")).toBeTruthy();
  expect(screen.getByText("added")).toBeTruthy();
});

it("opens a file to show its diff with line numbers, and says when there is none", async () => {
  server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("tab", { name: "Files · 2" }));
  const changed = screen.getByRole("button", { name: /Declined\.tsx\b(?!.*test)/ });
  expect(changed.getAttribute("aria-expanded")).toBe("false");
  await user.click(changed);
  const diff = await screen.findByRole("table", { name: "Changes" });
  const rows = within(diff).getAllByRole("row");
  expect(rows).toHaveLength(6);
  expect(rows[0]!.className).toContain("dl-hunk");
  expect(rows[2]!.className).toContain("dl-del");
  expect(rows[2]!.textContent).toContain("  return <p>Declined</p>;".trim());
  expect(rows[2]!.querySelectorAll(".dn")[0]!.textContent).toBe("11");
  expect(rows[3]!.className).toContain("dl-add");
  expect(rows[3]!.querySelectorAll(".dn")[1]!.textContent).toBe("11");
  await user.click(changed);
  expect(screen.queryByRole("table", { name: "Changes" })).toBeNull();

  await user.click(screen.getByRole("button", { name: /Declined\.test\.tsx/ }));
  expect(await screen.findByText(/No diff to show here/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "View it on GitHub" }).getAttribute("href")).toBe(`${PULL.htmlUrl}/files`);
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

it("shows the description as markdown without HTML comments or raw HTML", async () => {
  server({
    ...PULL,
    body: "<!-- fill this in -->\n## Summary\n\nAdds **bold** and [a link](https://example.com).\n\n<script>alert(1)</script>\n\n- [x] done\n",
  });
  const { container } = at("/pr/pr-1");
  expect(await screen.findByRole("heading", { name: "Summary" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("a[href='https://example.com']")?.getAttribute("rel")).toContain("noopener");
  expect(container.textContent).not.toContain("fill this in");
  expect(container.querySelector("script")).toBeNull();
});

it("says there is no description when the body is only comments", async () => {
  server({ ...PULL, body: "<!--\nTemplate help\n-->" });
  at("/pr/pr-1");
  expect(await screen.findByText("The author did not write a description.")).toBeTruthy();
});

it("shows the check runs and a summary of them", async () => {
  server({
    ...PULL,
    checksState: "failing",
    checks: [
      { name: "Web (tsc, vitest)", status: "completed", conclusion: "failure", url: "https://github.com/acme/shop/actions/runs/1/job/2", startedAt: "x", completedAt: "x" },
      { name: "E2E", status: "in_progress", conclusion: null, url: "", startedAt: "x", completedAt: null },
      { name: "Rust", status: "completed", conclusion: "success", url: "", startedAt: "x", completedAt: "x" },
    ],
  });
  at("/pr/pr-1");
  expect(await screen.findByText("tests 1/3")).toBeTruthy();
  const link = screen.getByRole("link", { name: "Web (tsc, vitest)" });
  expect(link.getAttribute("href")).toContain("/actions/runs/1");
  expect(within(link.closest("li")!).getByText("failure")).toBeTruthy();
  expect(within(screen.getByText("E2E").closest("li")!).getByText("running")).toBeTruthy();
  expect(within(screen.getByText("Rust").closest("li")!).getByText("passed")).toBeTruthy();
});

/** A WebSocket the test can push project events through. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  seq = 0;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  push(event: string, data: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ id: ++this.seq, projectId: "p1", jobId: "wh-1", event, data, createdAt: "x" }) });
  }
}

it("refreshes the open pull request when a webhook changes it, without a reload", async () => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  server(PULL);
  // The server above answers from its own copy; swap the title there by mutating what it returns.
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const original = fetchMock.getMockImplementation() as (input: Request | string, init?: RequestInit) => Promise<Response>;
  let title = PULL.title;
  fetchMock.mockImplementation(async (input: Request | string, init?: RequestInit) => {
    const res = await original(input, init);
    const url = new URL(input instanceof Request ? input.url : input, "http://x");
    if (url.pathname === "/api/projects/p1/pulls/pr-1") return Response.json({ ...(await res.json()), title });
    return res;
  });
  at("/pr/pr-1");
  expect(await screen.findByRole("heading", { name: PULL.title })).toBeTruthy();
  await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  expect(FakeSocket.all[0]!.url).toContain("/api/projects/p1/events");

  title = "Checkout: show the decline reason";
  FakeSocket.all[0]!.push("pr.updated", { repo: "acme/shop", number: 58, cause: "pull_request.edited" });
  expect(await screen.findByRole("heading", { name: "Checkout: show the decline reason" })).toBeTruthy();
});

it("reconnects with a growing wait and catches up on what it missed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    server(PULL);
    at("/pr/pr-1");
    await screen.findByRole("heading", { name: PULL.title });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.push("pr.updated");
    FakeSocket.all[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).toContain("?after=1"); // resumes after the last event seen
    FakeSocket.all[1]!.onclose?.(); // still down: wait doubles
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.all).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});

it("shows the gates, the review card and the context the reviewer would use", async () => {
  server({ ...PULL, checksState: "failing", gates: gates(["review", "findings", "tests", "approval"]).map((g) => (g.id === "approval" ? { ...g, label: "Your approval · 0/1" } : g)) });
  const user = userEvent.setup();
  at("/pr/pr-1");
  expect(await screen.findByText("No agent review yet")).toBeTruthy();
  expect(screen.getByText("○ Tests pass")).toBeTruthy();
  expect(screen.getByText(/Your approval · 0\/1/)).toBeTruthy();
  expect(screen.getByText("4 gates open")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Merge PR" }) as HTMLButtonElement).disabled).toBe(true); // a named gate is open
  expect(screen.getByText("Edit context").getAttribute("href")).toBe("/project");
  await user.click(screen.getByRole("tab", { name: "Findings" }));
  expect(screen.getByText("No agent review yet")).toBeTruthy();
});

const REVIEW = {
  id: "rv-1", pullId: "pr-1", jobId: "j1", headSha: "abc", state: "succeeded", stage: "done", backend: "user_key", model: "claude-opus-5-5", error: null,
  createdAt: "x", finishedAt: "y", dropped: 2, walkthrough: "The **declined** screen now names the reason.",
  summary: "", risk: null, riskReason: "", steps: [], decisions: [],
  findings: [{ id: 1, severity: "high", path: "src/pay.rs", line: 7, title: "Charges twice on retry", body: "A new key per attempt.", suggestedFix: "Reuse the order key.", spec: "spec/checkout.md" }],
};

it("starts an agent review and shows its first stage", async () => {
  const s = server(PULL);
  const user = userEvent.setup();
  at("/pr/pr-1");
  await user.click(await screen.findByRole("button", { name: "Run agent review" }));
  expect(await screen.findByText("Reading the diff and the linked specs…")).toBeTruthy();
  expect(screen.getByText("reviewing")).toBeTruthy();
  expect(s.posted).toEqual([{ path: "/api/projects/p1/pulls/pr-1/agent-review", body: null }]);
});

it("shows a finished review: walkthrough, findings and the review gates", async () => {
  server({ ...PULL, gates: gates(["findings"]) }, 200, false, REVIEW);
  const user = userEvent.setup();
  at("/pr/pr-1");
  expect(await screen.findByText("declined")).toBeTruthy();
  expect(screen.getByText("Reviewed with your Anthropic API key · claude-opus-5-5.")).toBeTruthy();
  expect(screen.getByText("✓ Agent review finished")).toBeTruthy();
  expect(screen.getByText("○ No open high or medium findings")).toBeTruthy();
  expect(screen.queryByText("No agent review yet")).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Findings · 1" }));
  expect(screen.getByText("Charges twice on retry")).toBeTruthy();
  expect(screen.getByText("Reuse the order key.")).toBeTruthy();
  expect(screen.getByText("The refuters dropped 2 findings they could not confirm.")).toBeTruthy();
});

it("shows the walkthrough as numbered steps with impact, risk and questions for the owner", async () => {
  server(PULL, 200, false, {
    ...REVIEW,
    summary: "Declined payments now say why, next to the retry button.",
    risk: "medium",
    riskReason: "Touches the payment flow, but only what is shown.",
    steps: [
      { title: "Declined screen", paths: ["src/checkout/Declined.tsx"], spec: "checkout.failed", impact: "medium", change: "Shows the decline reason.", effect: "Shoppers see why their card failed.", code: "- <p>Declined</p>\n+ <p>Declined: {reason}</p>" },
      { title: "Tests", paths: ["src/checkout/Declined.test.tsx"], spec: null, impact: "low", change: "One new test.", effect: "", code: "" },
    ],
    decisions: ["Should the raw gateway reason be shown, or a friendlier one?"],
  });
  at("/pr/pr-1");
  expect(await screen.findByText("Declined payments now say why, next to the retry button.")).toBeTruthy();
  expect(screen.getByText("Declined screen")).toBeTruthy();
  expect(screen.getByText("checkout.failed")).toBeTruthy();
  expect(screen.getByText("medium impact")).toBeTruthy();
  expect(screen.getByText("low impact")).toBeTruthy();
  expect(screen.getByText("Shoppers see why their card failed.")).toBeTruthy();
  // The step's file shows its real diff from GitHub, open, after the change and what it affects.
  const diff = await screen.findByRole("table", { name: "Changes" });
  expect(diff.textContent).toContain("return <p>Declined: {reason}</p>;");
  const step = screen.getByText("Declined screen").closest(".walk-step")!;
  const text = step.textContent!;
  expect(text.indexOf("Shows the decline reason.")).toBeLessThan(text.indexOf("Shoppers see why"));
  expect(text.indexOf("Shoppers see why")).toBeLessThan(text.indexOf("src/checkout/Declined.tsx"));
  // The reviewer's own excerpt is not repeated when the real diff is there.
  expect(screen.queryByText("+ <p>Declined: {reason}</p>")).toBeNull();
  expect(screen.getAllByText("risk MEDIUM")).toHaveLength(2); // header and the risk card
  expect(screen.getByText("Touches the payment flow, but only what is shown.")).toBeTruthy();
  expect(screen.getByText("Should the raw gateway reason be shown, or a friendlier one?")).toBeTruthy();
  // The author's own description moves below the walkthrough.
  expect(screen.getByText("The author's description")).toBeTruthy();
});

it("offers to run again when the review is of an older commit", async () => {
  server({ ...PULL, gates: gates(["review", "findings"]) }, 200, false, { ...REVIEW, headSha: "old" });
  at("/pr/pr-1");
  expect(await screen.findByText("New commits since the agent review")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run agent review again" })).toBeTruthy();
  expect(screen.getByText(/○ Agent review finished/)).toBeTruthy(); // not checked for this commit
});
