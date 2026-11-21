import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const get = (path: string) => exports.default.fetch(new Request(`http://spectrace.test${path}`));

describe("GET /api/health", () => {
  it("reports ok with a working database", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "spectrace-worker", database: "ok" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns a JSON 500 that hides details when the database fails", async () => {
    const real = env.DB.prepare;
    env.DB.prepare = () => {
      throw new Error("boom: secret detail");
    };
    try {
      const res = await get("/api/health");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal", message: "internal server error" } });
    } finally {
      env.DB.prepare = real;
    }
  });
});

describe("errors", () => {
  it("returns a JSON 404 for unknown API routes", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found: /api/nope" } });
  });

  it("serves the OpenAPI document", async () => {
    const res = await get("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/health");
  });
});

describe("migrations", () => {
  it("applies 0001_init", async () => {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'schema'").first<{ value: string }>();
    expect(row?.value).toBe("spectrace");
  });
});
