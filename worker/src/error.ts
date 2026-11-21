import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "@hono/zod-openapi";
import type { AppEnv } from "./env";
import { log } from "./log";

const KINDS = {
  not_found: 404,
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  upstream: 502,
  not_configured: 503,
  internal: 500,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof KINDS;

/**
 * The one error type for the Worker. Throw it from handlers; `onError` turns
 * it into `{"error": {"code", "message"}}`. 5xx messages are never sent to
 * the client, they are logged instead.
 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }

  get status(): ContentfulStatusCode {
    return KINDS[this.code];
  }

  static notFound(what: string) {
    return new AppError("not_found", `not found: ${what}`);
  }
  static badRequest(why: string) {
    return new AppError("bad_request", `bad request: ${why}`);
  }
  static unauthorized(why: string) {
    return new AppError("unauthorized", `unauthorized: ${why}`);
  }
}

/** Schema for the error body, for OpenAPI responses. */
export const ErrorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

export function errorResponse(c: Context<AppEnv>, err: unknown) {
  const app = err instanceof AppError ? err : new AppError("internal", String(err), { cause: err });
  const requestId = c.get("requestId");
  const format = c.env?.LOG_FORMAT;
  if (app.status >= 500) {
    log("error", "request failed", { requestId, code: app.code, error: app.message, cause: String(app.cause ?? "") }, format);
  }
  const message = app.status >= 500 && app.code !== "not_configured" ? "internal server error" : app.message;
  return c.json({ error: { code: app.code, message } }, app.status);
}
