import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "./env";
import { AppError, errorResponse } from "./error";
import { log } from "./log";
import { registerAuth } from "./routes/auth";
import { registerHealth } from "./routes/health";
import { registerJobs } from "./routes/jobs";

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    // Request validation failures become the same JSON error as everything else.
    defaultHook: (result, c) => {
      if (!result.success) return errorResponse(c, AppError.badRequest(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
    },
  });

  app.use("*", async (c, next) => {
    const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    const start = Date.now();
    await next();
    c.header("x-request-id", requestId);
    log(
      "info",
      "request",
      { requestId, method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - start },
      c.env?.LOG_FORMAT,
    );
  });

  registerHealth(app);
  registerAuth(app);
  registerJobs(app);

  app.doc("/api/openapi.json", { openapi: "3.1.0", info: { title: "spectrace API", version: "0.1.0" } });

  app.notFound((c) => errorResponse(c, AppError.notFound(new URL(c.req.url).pathname)));
  app.onError((err, c) => errorResponse(c, err));
  return app;
}
