import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";
import type { Request, WebSocketRoute } from "@playwright/test";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};
type Block = { id: string; kind: "note" | "mermaid"; text: string };
const BEFORE = { id: "w1", title: "Checkout", createdAt: "x", updatedAt: "2026-11-22T13:00:00.000Z", blocks: [{ id: "b1", kind: "mermaid", text: "flowchart LR" }] as Block[] };
const AFTER = { ...BEFORE, title: "Checkout flow", updatedAt: "2026-11-22T13:01:00.000Z", blocks: [...BEFORE.blocks, { id: "b2", kind: "note", text: "- Pay: WHEN the card is declined THE SYSTEM SHALL show why." }] as Block[] };
const msg = (id: string, role: "user" | "coordinator", text: string) => ({ id, role, text, tools: [], actions: [], ran: [], board: null, createdAt: "2026-11-22T13:00:00Z" });
const live = (event: string, data: Record<string, unknown>) => JSON.stringify({ id: -1, projectId: "p1", jobId: "", event, data, createdAt: "2026-11-22T13:00:00Z" });

async function base(page: import("@playwright/test").Page, extra: Record<string, unknown> = {}) {
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/requirements": [],
    "/api/projects/p1/boards": [{ id: "w1", title: "Checkout", blocks: 1, updatedAt: BEFORE.updatedAt }],
    ...extra,
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
}

/** Opens the coordinator where it starts closed (phones). */
async function openPanel(page: import("@playwright/test").Page) {
  const panel = page.getByRole("complementary", { name: "Coordinator" });
  if ((page.viewportSize()?.width ?? 0) <= 1100 && !(await panel.isVisible())) await page.getByRole("button", { name: /coordinator/ }).first().click();
  return panel;
}

// Requirements studio, phase 5: what the coordinator does reaches every device
// that has the board open, as it happens.
test("another device sees the coordinator thinking, then its reply and the new board, without a reload", async ({ page }) => {
  let board = BEFORE;
  let messages: unknown[] = [];
  let saves = 0;
  await base(page, {
    "/api/projects/p1/boards/w1": (req: Request) => {
      if (req.method() === "PUT") saves++;
      return board;
    },
    "/api/projects/p1/coordinator": () => ({ messages }),
  });
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/api\/projects\/p1\/events/, (ws) => {
    socket = ws;
  });
  const errors = trackErrors(page);
  await page.goto("/board/w1");
  await expect(page.getByLabel("Board title")).toHaveValue("Checkout");
  await expect.poll(() => !!socket).toBe(true);

  // On the other device, the question goes in.
  socket!.send(live("studio.thinking", { userId: USER.id, boardId: "w1", setId: null }));
  const panel = await openPanel(page);
  await expect(panel.getByRole("status")).toHaveText("coordinator is thinking and sketching…");

  // Its answer lands: the conversation and the board move here too.
  messages = [msg("m1", "user", "Let's sketch checkout"), msg("m2", "coordinator", "What happens when the card is declined?")];
  board = AFTER;
  socket!.send(live("studio.messages", { userId: USER.id }));
  socket!.send(live("studio.board", { boardId: "w1", updatedAt: AFTER.updatedAt }));
  await expect(panel.getByText("What happens when the card is declined?")).toBeVisible();
  await expect(panel.getByRole("status")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) <= 1100) await panel.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Board title")).toHaveValue("Checkout flow");
  await expect(page.getByLabel("Note, block 2")).toHaveValue(AFTER.blocks[1]!.text);
  await expectNoHorizontalScroll(page);

  // A version the page already shows is not read again, and nothing is saved back.
  socket!.send(live("studio.board", { boardId: "w1", updatedAt: AFTER.updatedAt }));
  await page.waitForTimeout(800);
  expect(saves).toBe(0);
  expect(errors).toEqual([]);
});

test("you can speak to the coordinator, and hear its reply", async ({ page }) => {
  let asked: unknown = null;
  await base(page, {
    "/api/projects/p1/boards/w1": BEFORE,
    "/api/projects/p1/coordinator": (req: Request) => {
      if (req.method() === "GET") return { messages: [] };
      asked = req.postDataJSON();
      return { messages: [msg("m1", "user", "Let's sketch checkout"), msg("m2", "coordinator", "What happens when the card is declined?")], board: null, requirementSet: null };
    },
  });
  // The browser's speech, faked: recognition hears one sentence, synthesis records what it says.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__spoken = [];
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        const result = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
        setTimeout(() => this.onresult?.({ results: [result("Let's sketch", false)] }), 50);
        setTimeout(() => {
          this.onresult?.({ results: [result("Let's sketch checkout", true)] });
          this.onend?.();
        }, 150);
      }
      stop() {
        this.onend?.();
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.SpeechSynthesisUtterance = class {
      constructor(public text: string) {}
    };
    Object.defineProperty(window, "speechSynthesis", {
      value: { speak: (u: { text: string }) => (w.__spoken as string[]).push(u.text), cancel: () => undefined },
    });
  });
  const errors = trackErrors(page);
  await page.goto("/board/w1");
  const panel = await openPanel(page);
  await expect(panel.getByLabel("Message the coordinator")).toBeVisible();

  const aloud = panel.getByRole("button", { name: "Read aloud" });
  await expect(aloud).toHaveAttribute("aria-pressed", "false");
  await aloud.click();
  await expect(aloud).toHaveAttribute("aria-pressed", "true");

  await panel.getByRole("button", { name: "Speak" }).click();
  await expect(panel.getByText("What happens when the card is declined?")).toBeVisible();
  expect(asked).toEqual({ text: "Let's sketch checkout", screen: { route: "board", boardId: "w1" } });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(["What happens when the card is declined?"]);
  await expect(panel.getByRole("button", { name: "Speak" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
