import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";

const route = createRoute({
  method: "get",
  path: "/api/health",
  summary: "Liveness plus a database round trip",
  responses: {
    200: {
      description: "The Worker and its database are up",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            service: z.string(),
            database: z.literal("ok"),
          }),
        },
      },
    },
    500: { description: "The database is unreachable", content: { "application/json": { schema: ErrorBody } } },
  },
});

export function registerHealth(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async (c) => {
    try {
      const row = await c.env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
      if (row?.one !== 1) throw new Error("unexpected result from SELECT 1");
    } catch (cause) {
      throw new AppError("internal", "database health check failed", { cause });
    }
    return c.json({ status: "ok" as const, service: "spectrace-worker", database: "ok" as const }, 200);
  });
}
