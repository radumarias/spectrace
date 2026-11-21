import { expect, expectNoHorizontalScroll, mockApi, test, trackErrors, USER } from "./fixtures";

const PROJECT = {
  id: "p1", name: "Shop app", context: "", created_at: "x", updated_at: "x",
  repos: [{ id: "r1", github_repo_id: null, full_name: "acme/shop", default_branch: "main", index_state: "ready" }],
};

// T5.7 "Done when": draw a flowchart on a new board (3 boxes, 2 arrows), see it
// drawn, turn it into requirements, and the draft parses with no errors and
// opens in the diagram editor.
test("a whiteboard flowchart becomes a draft spec in the diagram editor", async ({ page }) => {
  type Saved = { title: string; blocks: { id: string; kind: string; text: string }[] };
  let board: (Saved & { id: string; createdAt: string; updatedAt: string }) | null = null;
  let added: { repoId: string; path: string; source: string; summary: string[] } | null = null;
  await mockApi(page, {
    "/api/me": USER,
    "/api/projects": [PROJECT],
    "/api/projects/p1/pulls": { pulls: [], counts: { needs: 0, open: 0, merged: 0 } },
    "/api/projects/p1/boards": (req: import("@playwright/test").Request) => {
      if (req.method() === "POST") {
        board = { id: "w1", createdAt: "x", updatedAt: "2026-11-21T18:00:00Z", ...(req.postDataJSON() as Saved) };
        return { status: 201, body: board };
      }
      return board ? [{ id: board.id, title: board.title, blocks: board.blocks.length, updatedAt: board.updatedAt }] : [];
    },
    "/api/projects/p1/boards/w1": (req: import("@playwright/test").Request) => {
      if (req.method() === "PUT") board = { ...board!, ...(req.postDataJSON() as Saved) };
      return board;
    },
    "/api/projects/p1/specs/new": (req: import("@playwright/test").Request) => {
      added = req.postDataJSON() as typeof added;
      return { status: 201, body: { number: 8, url: "https://github.com/acme/shop/pull/8", branch: "spectrace/spec-sign_up-x" } };
    },
  });
  await page.addInitScript(() => localStorage.setItem("spectrace-proj", "p1"));
  const errors = trackErrors(page);
  await page.goto("/board");

  await expect(page.getByText("No boards yet.")).toBeVisible();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(/\/board\/w1$/);
  await page.getByLabel("Board title").fill("Sign up");

  // Three boxes, each after the selected one, which gives two arrows.
  const block = page.getByRole("region", { name: "Block 1" });
  for (let i = 0; i < 3; i++) await block.getByRole("button", { name: "+ Box" }).click();
  const dia = block.getByRole("group", { name: "Flowchart, block 1" }).first();
  await expect(dia.locator(".pele-node")).toHaveCount(3);
  await expect(dia.locator(".pele-edge, .pele-edges path, g[class*=edge]").first()).toBeAttached();
  await expect(block.getByLabel("Mermaid text, block 1")).toHaveValue("flowchart LR\n  n1[Box 1]\n  n2[Box 2]\n  n3[Box 3]\n  n1 --> n2\n  n2 --> n3");

  // Rename the boxes through the quick shapes; the text stays the source.
  for (const [box, name] of [["Box 1", "Form"], ["Box 2", "Confirm email"], ["Box 3", "Welcome"]] as const) {
    await dia.getByRole("button", { name: box }).click();
    await block.getByLabel("Box label").fill(name);
    await block.getByLabel("Box label").press("Enter");
    await expect(dia.getByRole("button", { name })).toBeVisible();
  }
  await expect(block.getByLabel("Mermaid text, block 1")).toHaveValue(/n2\[Confirm email\]/);

  // A note gives Confirm email a requirement line; another diagram type is drawn too.
  await page.getByRole("button", { name: "+ Note" }).click();
  await page.getByLabel("Note, block 2").fill("- Confirm email: WHEN the link is older than 24 hours THE SYSTEM SHALL send a new one.");
  await page.getByRole("button", { name: "+ Diagram" }).click();
  await expect(page.getByRole("img", { name: "Diagram, block 3" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect.poll(() => board?.blocks.length).toBe(3);
  expect(board!.title).toBe("Sign up");
  await expectNoHorizontalScroll(page);

  await block.getByRole("button", { name: "Turn into requirements" }).click();
  const setup = page.getByRole("region", { name: "Turn into requirements" });
  await expect(setup.getByLabel("Flow id (the file name)")).toHaveValue("sign_up");
  await expect(setup.getByText("spec/sign_up.md")).toBeVisible();
  await setup.getByRole("button", { name: "Open in the diagram editor" }).click();

  // The draft opens in the diagram editor: parsed with no errors, three steps, the note's requirement on its step.
  await expect(page.getByRole("heading", { name: /Sign up\s+draft/ })).toBeVisible();
  const editor = page.getByRole("group", { name: "Sign up flow, editing" }).first();
  await expect(editor.locator(".pele-node")).toHaveCount(3);
  const diff = page.getByLabel("Spec diff");
  await expect(diff).toContainText("+ # Sign up {#sign_up}");
  await expect(diff).toContainText("+   form -->|next| confirm_email");
  await expect(diff).toContainText("+ - WHEN the link is older than 24 hours THE SYSTEM SHALL send a new one. {#r1}");
  await expect(diff).toContainText("+ ## Welcome {#sign_up.welcome}");

  // Edit it like any spec, then save it as a new file.
  await editor.getByRole("link", { name: "Welcome" }).click();
  const inspector = page.getByRole("complementary", { name: "Edit step" });
  await inspector.getByRole("button", { name: "+ Requirement" }).click();
  await page.getByRole("button", { name: "Save · 1 change" }).click();
  await expect(page.getByRole("region", { name: "Change summary" }).getByRole("listitem")).toHaveText(["Drafted from the whiteboard Sign up", "Added a requirement to Welcome"]);
  await page.getByRole("button", { name: "Open a pull request" }).click();
  await expect(page.getByRole("region", { name: "Saved" }).getByRole("link", { name: "#8" })).toBeVisible();
  expect(added).toMatchObject({ repoId: "r1", path: "spec/sign_up.md" });
  expect(added!.source).toContain("## Confirm email {#sign_up.confirm_email}");
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
