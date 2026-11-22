import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import type { Request } from "@playwright/test";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
const BOARD = {
  id: "w1", title: "Checkout", createdAt: "x", updatedAt: "2026-11-22T13:00:00.000Z",
  blocks: [{ id: "b1", kind: "mermaid", text: "flowchart LR\n  cart[Cart]\n  pay[Pay]\n  cart -->|checkout| pay" }],
};
const SOURCE = [
  "# Checkout {#checkout}", "", "```mermaid", "flowchart LR", "  cart[Cart]", "  pay[Pay]", "  cart -->|checkout| pay", "```", "",
  "## Cart {#checkout.cart}", "", "- WHEN the user opens the cart THE SYSTEM SHALL list every item with its price. {#r1}", "",
  "## Pay {#checkout.pay}", "", "- WHEN the user confirms payment THE SYSTEM SHALL charge the card once. {#r1}",
  "- WHEN a payment is declined THE SYSTEM SHALL show the reason. {#r2}", "", "> @flow Cards only for now: PayPal waits for the next release.", "",
].join("\n");
const span = { start: 0, end: 1 };
const req = (tag: string, condition: string, response: string, line: number) => ({ tag, condition, response, line, end_line: line, span });
const MODEL = {
  flow: "checkout",
  title: { text: "Checkout", id: "checkout", line: 1, span },
  diagram: {
    direction: "LR", line: 3, span, body: span, header: null,
    nodes: [{ id: "cart", label: "Cart", line: 5, span }, { id: "pay", label: "Pay", line: 6, span }],
    edges: [{ from: "cart", label: "checkout", to: "pay", line: 7, span }], clicks: [], actions: [], comments: [],
  },
  sections: [
    { id: "checkout.cart", node: "cart", title: "Cart", line: 10, heading: span, span, requirements: [req("r1", "the user opens the cart", "list every item with its price", 12)], flow: null },
    {
      id: "checkout.pay", node: "pay", title: "Pay", line: 14, heading: span, span,
      requirements: [req("r1", "the user confirms payment", "charge the card once", 16), req("r2", "a payment is declined", "show the reason", 17)],
      flow: { text: "Cards only for now: PayPal waits for the next release.", line: 19, end_line: 19, span },
    },
  ],
  head: span,
};
const SET = {
  id: "s1", title: "Checkout", boardId: "w1", createdAt: "x", updatedAt: "2026-11-22T13:05:00.000Z",
  flows: [{ flow: "checkout", title: "Checkout", path: "spec/checkout.md", source: SOURCE, model: MODEL, diagnostics: [] }],
  views: [
    { id: "v1", of: "checkout.pay", kind: "mockup", title: "Pay screen", text: "### Pay\n\n| Item | Price |\n|---|---|\n| Mug | 12 EUR |\n\n- Card number\n- [Pay now]\n\nShows: checkout.pay/r1" },
    { id: "v2", of: null, kind: "diagram", title: "Calls to the bank", text: "sequenceDiagram\n  App->>Bank: charge\n  Bank-->>App: declined" },
    { id: "v3", of: null, kind: "note", title: "Open questions", text: "- Do we keep the cart for 14 days?" },
  ],
  ids: ["checkout", "checkout.cart", "checkout.cart/r1", "checkout.pay", "checkout.pay/r1", "checkout.pay/r2"],
};

// Requirements studio, phase 2: one click on the board drafts requirements with stable ids,
// shown per step with the mockups and diagrams that illustrate them.
test("Draft requirements turns the board into flows, ids, mockups and diagrams", async ({ page }) => {
  let drafted: unknown = null;
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/coordinator": { messages: [] },
    "/api/projects/p1/boards": [{ id: "w1", title: "Checkout", blocks: 1, updatedAt: BOARD.updatedAt }],
    "/api/projects/p1/boards/w1": BOARD,
    "/api/projects/p1/requirements": (r: Request) => {
      if (r.method() === "POST") {
        drafted = r.postDataJSON();
        return { status: 201, body: SET };
      }
      return drafted ? [{ id: "s1", title: "Checkout", boardId: "w1", flows: 1, requirements: 3, updatedAt: SET.updatedAt }] : [];
    },
    "/api/projects/p1/requirements/s1": SET,
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/board/w1");
  await page.getByRole("button", { name: "Draft requirements" }).click();
  await expect(page).toHaveURL(/\/req\/s1$/);
  expect(drafted).toEqual({ boardId: "w1" });

  await expect(page.getByRole("heading", { name: "Checkout", level: 1 })).toBeVisible();
  await expect(page.getByText("1 flow, 3 requirements, 3 views.", { exact: false })).toBeVisible();
  const flow = page.getByRole("region", { name: "Flow Checkout" });
  await expect(flow.locator(".pele-node")).toHaveCount(2);
  const pay = page.getByRole("region", { name: "Step Pay" });
  await expect(pay.getByText("checkout.pay/r2")).toBeVisible();
  await expect(pay.getByText("show the reason", { exact: false })).toBeVisible();
  await expect(pay.getByText("Cards only for now", { exact: false })).toBeVisible();
  const mock = pay.getByRole("figure", { name: "Mockup: Pay screen" });
  await expect(mock.getByRole("cell", { name: "12 EUR" })).toBeVisible();
  const also = page.getByRole("region", { name: "Also discussed" });
  await expect(also.getByRole("img", { name: "Calls to the bank" })).toBeVisible();
  await expect(also.getByText("Do we keep the cart for 14 days?")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Clicking a box in the flow selects its step.
  await flow.getByRole("button", { name: "Cart" }).first().click();
  await expect(page).toHaveURL(/step=checkout\.cart/);
  await expect(page.getByRole("region", { name: "Step Cart" })).toHaveClass(/on/);

  await page.getByRole("tab", { name: "Spec files" }).click();
  await expect(page.getByLabel("Spec file spec/checkout.md")).toContainText("## Pay {#checkout.pay}");
  await expectNoHorizontalScroll(page);

  // The list and the board both lead back to the set.
  await page.goto("/req");
  await expect(page.getByRole("link", { name: /Checkout\s+1 flow · 3 requirements/ })).toBeVisible();
  await page.goto("/board/w1");
  await expect(page.getByText("Requirements from this board:")).toBeVisible();
  expect(errors).toEqual([]);
});

// Requirements studio, phase 3: on a set the coordinator sits beside it; asking for a change
// edits only that part, lists it by id under the reply, and Undo puts it back.
test("the coordinator revises the requirements by id, and Undo takes it back", async ({ page }) => {
  const R3 = "- WHEN the bank takes over 10 seconds THE SYSTEM SHALL show a spinner. {#r3}";
  const pay = MODEL.sections[1]!;
  const REVISED = {
    ...SET,
    updatedAt: "2026-11-22T13:06:00.000Z",
    flows: [{
      ...SET.flows[0]!,
      source: SOURCE.replace("show the reason. {#r2}\n", `show the reason. {#r2}\n${R3}\n`),
      model: { ...MODEL, sections: [MODEL.sections[0]!, { ...pay, requirements: [...pay.requirements, req("r3", "the bank takes over 10 seconds", "show a spinner", 18)] }] },
    }],
    ids: [...SET.ids, "checkout.pay/r3"],
  };
  const edit = { setId: "s1", changes: ["Added checkout.pay/r3"], skipped: [], undone: false };
  const msg = (id: string, role: string, text: string, extra = {}) => ({ id, role, text, tools: [], actions: [], ran: [], board: null, requirements: null, createdAt: "2026-11-22T13:00:00Z", ...extra });
  let asked: unknown = null;
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/requirements": [],
    "/api/projects/p1/requirements/s1": SET,
    "/api/projects/p1/coordinator": (r: Request) => {
      if (r.method() === "GET") return { messages: [] };
      asked = r.postDataJSON();
      return {
        messages: [msg("m1", "user", "Show a spinner when the bank is slow"), msg("m2", "coordinator", "Added checkout.pay/r3 for a slow bank.", { requirements: edit })],
        board: null,
        requirementSet: REVISED,
      };
    },
    "/api/projects/p1/coordinator/m2/undo": () => ({
      messages: [msg("m2", "coordinator", "Added checkout.pay/r3 for a slow bank.", { requirements: { ...edit, undone: true } })],
      board: null,
      requirementSet: { ...SET, ids: REVISED.ids, updatedAt: "2026-11-22T13:07:00.000Z" },
    }),
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/req/s1");
  await expect(page.getByRole("heading", { name: "Checkout", level: 1 })).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Coordinator" });
  const wide = (page.viewportSize()?.width ?? 0) > 1100;
  if (!wide) await page.getByRole("button", { name: /coordinator/ }).first().click();
  await expect(panel.getByText("every id that already exists stays the same", { exact: false })).toBeVisible();
  await panel.getByLabel("Message the coordinator").fill("Show a spinner when the bank is slow");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByLabel("Changes to the requirements").getByText("Added checkout.pay/r3")).toBeVisible();
  expect(asked).toEqual({ text: "Show a spinner when the bank is slow", screen: { route: "req", setId: "s1" } });
  if (!wide) await panel.getByRole("button", { name: "Close" }).click();
  const step = page.getByRole("region", { name: "Step Pay" });
  await expect(step.getByText("checkout.pay/r3", { exact: true })).toBeVisible();
  await expect(step.getByText("checkout.pay/r1", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  if (!wide) await page.getByRole("button", { name: /coordinator/ }).first().click();
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("Undone")).toBeVisible();
  if (!wide) await panel.getByRole("button", { name: "Close" }).click();
  await expect(step.getByText("checkout.pay/r3", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
