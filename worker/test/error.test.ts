import { describe, expect, it } from "vitest";
import { AppError } from "../src/error";

describe("AppError", () => {
  it("maps each kind to an HTTP status", () => {
    expect(AppError.notFound("pr 1").status).toBe(404);
    expect(AppError.badRequest("x").status).toBe(400);
    expect(AppError.unauthorized("x").status).toBe(401);
    expect(new AppError("upstream", "x").status).toBe(502);
    expect(new AppError("internal", "x").status).toBe(500);
  });
});
