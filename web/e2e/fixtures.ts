import { test as base, expect, type Page, type Request, type Route } from "@playwright/test";

export const USER = { id: "u1", github_id: 1, login: "octocat", name: "The Octocat", avatar_url: null };

/**
 * A canned answer for one API path: JSON with status 200, or `{ status, body }`.
 * A function gets the request and returns either form.
 */
export type ApiAnswer =
  | unknown
  | { status: number; body: unknown }
  | ((req: Request) => unknown | { status: number; body: unknown });

/**
 * Mock `/api/*` in the browser. Paths not listed answer 404 `not_found`, so a missing
 * mock shows up in the test instead of being silently ignored. Call before `page.goto`.
 */
export async function mockApi(page: Page, answers: Record<string, ApiAnswer>) {
  // The shell listens to the project's event socket. Quiet by default; a spec that cares routes it again after calling mockApi (the last matching route wins).
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/events/, () => {});
  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const answer = path in answers ? answers[path] : undefined;
    const resolved = typeof answer === "function" ? answer(req) : answer;
    if (path in answers && isStatus(resolved)) {
      return route.fulfill({ status: resolved.status, json: resolved.body });
    }
    if (path in answers) return route.fulfill({ status: 200, json: resolved });
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: `no mock for ${path}` } } });
  });
}

function isStatus(v: unknown): v is { status: number; body: unknown } {
  return typeof v === "object" && v !== null && "status" in v && "body" in v;
}

/** Stop Google Fonts from leaving the test run; an empty stylesheet keeps the page quiet. */
export async function stubFonts(page: Page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
}

/** Collects console errors and uncaught page errors for the test to assert on. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** Fails when the page is wider than the viewport, which is the "no horizontal scroll" rule. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll, "page scrolls sideways").toBeLessThanOrEqual(overflow.client);
}

export const test = base.extend<{ fontsStubbed: void }>({
  fontsStubbed: [
    async ({ page }, use) => {
      await stubFonts(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
