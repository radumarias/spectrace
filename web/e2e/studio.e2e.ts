import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import type { Request } from "@playwright/test";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
type Block = { id: string; kind: "note" | "mermaid"; text: string };
const BEFORE = { id: "w1", title: "Checkout", createdAt: "x", updatedAt: "2026-11-22T13:00:00.000Z", blocks: [{ id: "b1", kind: "mermaid", text: "flowchart LR" }] as Block[] };
const FLOW = "flowchart LR\n  cart[Cart]\n  pay[Pay]\n  cart -->|checkout| pay";
const AFTER = {
  ...BEFORE,
  title: "Checkout flow",
  updatedAt: "2026-11-22T13:01:00.000Z",
  blocks: [{ id: "b1", kind: "mermaid", text: FLOW }, { id: "b2", kind: "note", text: "- Pay: WHEN the card is declined THE SYSTEM SHALL show why." }] as Block[],
};
const msg = (id: string, role: "user" | "coordinator", text: string, extra: Record<string, unknown> = {}) => ({ id, role, text, tools: [], actions: [], ran: [], board: null, createdAt: "2026-11-22T13:00:00Z", ...extra });

// Requirements studio, phase 1: on a whiteboard the coordinator sits beside the
// board (desktop) or opens over it (phone), talks the idea through and draws
// on the board in the same reply; one click undoes what it drew.
test("the coordinator sketches on the whiteboard while you talk, and Undo takes it back", async ({ page }) => {
  let asked: unknown = null;
  let saves = 0;
  const changes = { boardId: "w1", changes: ["Changed a flowchart (block 1)", "Added a note", "Renamed the board to Checkout flow"], undone: false };
  const reply = msg("m2", "coordinator", "Here is the flow as I understand it. What happens when the card is declined?", { board: changes });
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/boards": [{ id: "w1", title: "Checkout", blocks: 1, updatedAt: BEFORE.updatedAt }],
    "/api/projects/p1/boards/w1": (req: Request) => {
      if (req.method() === "PUT") saves++;
      return BEFORE;
    },
    "/api/projects/p1/coordinator": (req: Request) => {
      if (req.method() === "GET") return { messages: [] };
      asked = req.postDataJSON();
      return { messages: [msg("m1", "user", "Let's sketch checkout"), reply], board: AFTER };
    },
    "/api/projects/p1/coordinator/m2/undo": () => ({ messages: [{ ...reply, board: { ...changes, undone: true } }], board: { ...BEFORE, updatedAt: "2026-11-22T13:02:00.000Z" } }),
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/board/w1");
  await expect(page.getByLabel("Board title")).toHaveValue("Checkout");

  const panel = page.getByRole("complementary", { name: "Coordinator" });
  const wide = (page.viewportSize()?.width ?? 0) > 1100;
  if (wide) await expect(panel).toBeVisible();
  else {
    await expect(panel).toBeHidden();
    await page.getByRole("button", { name: /coordinator/ }).first().click();
  }
  await expect(panel.getByText("sketch it on this board as we talk", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sketch this flow with me" })).toBeVisible();

  await panel.getByLabel("Message the coordinator").fill("Let's sketch checkout");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText("What happens when the card is declined?", { exact: false })).toBeVisible();
  expect(asked).toEqual({ text: "Let's sketch checkout", screen: { route: "board", boardId: "w1" } });
  await expect(panel.getByText("Added a note")).toBeVisible();

  // The board takes the coordinator's version at once, and does not save it back.
  if (!wide) await panel.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Board title")).toHaveValue("Checkout flow");
  const block = page.getByRole("region", { name: "Block 1" });
  await expect(block.getByRole("group", { name: "Flowchart, block 1" }).first().locator(".pele-node")).toHaveCount(2);
  await expect(page.getByLabel("Note, block 2")).toHaveValue(AFTER.blocks[1]!.text);
  await expectNoHorizontalScroll(page);

  if (!wide) await page.getByRole("button", { name: /coordinator/ }).first().click();
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("Undone")).toBeVisible();
  if (!wide) await panel.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Board title")).toHaveValue("Checkout");
  await expect(page.getByLabel("Note, block 2")).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(saves).toBe(0);
  expect(errors).toEqual([]);
});
