import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { gatewayName, MODELS } from "../ai";
import { ask } from "../claude-code";
import { ErrorBody } from "../error";

const route = createRoute({
  method: "get",
  path: "/api/ai/health",
  summary: "Send one tiny message to Claude, the way this user's agent work goes (signed-in users)",
  description:
    "For the owner in CLAUDE_CODE_OWNER, once Claude Code is set up, the message runs through Claude Code on the owner's subscription (`backend: claude-code`). Everyone else goes through the Messages API and AI Gateway with the API key (`backend: api`).",
  responses: {
    200: {
      description: "Claude answered",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            backend: z.enum(["claude-code", "api"]),
            model: z.string(),
            /** The AI Gateway name; only for `backend: api`. */
            gateway: z.string().optional(),
            reply: z.string(),
            ms: z.number().int(),
          }),
        },
      },
    },
    401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
    502: { description: "Claude Code, AI Gateway or Anthropic refused the call", content: { "application/json": { schema: ErrorBody } } },
    503: { description: "Neither Claude Code nor an Anthropic key is configured", content: { "application/json": { schema: ErrorBody } } },
  },
});

export function registerAi(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async (c) => {
    const user = await requireUser(c);
    const start = Date.now();
    const out = await ask(c.env, user.login, { model: MODELS.haiku, maxTokens: 16, prompt: "Reply with the single word OK." });
    return c.json(
      {
        status: "ok" as const,
        backend: out.backend,
        model: out.model,
        ...(out.backend === "api" ? { gateway: gatewayName(c.env) } : {}),
        reply: out.text,
        ms: Date.now() - start,
      },
      200,
    );
  });
}
