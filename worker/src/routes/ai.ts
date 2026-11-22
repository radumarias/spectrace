import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { createMessage, gatewayName, MODELS } from "../ai";
import { ErrorBody } from "../error";

const route = createRoute({
  method: "get",
  path: "/api/ai/health",
  summary: "Send one tiny message to Claude through AI Gateway (signed-in users)",
  responses: {
    200: {
      description: "Claude answered through the gateway",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            model: z.string(),
            gateway: z.string(),
            reply: z.string(),
            ms: z.number().int(),
          }),
        },
      },
    },
    401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
    502: { description: "AI Gateway or Anthropic refused the call", content: { "application/json": { schema: ErrorBody } } },
    503: { description: "No Anthropic key or gateway is configured", content: { "application/json": { schema: ErrorBody } } },
  },
});

export function registerAi(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async (c) => {
    await requireUser(c);
    const start = Date.now();
    const out = await createMessage(c.env, {
      model: MODELS.haiku,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    const reply = out.content.map((b) => b.text ?? "").join("").trim();
    return c.json({ status: "ok" as const, model: out.model, gateway: gatewayName(c.env), reply, ms: Date.now() - start }, 200);
  });
}
