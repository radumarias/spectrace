import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, Bindings } from "../env";
import { requireUser } from "../auth";
import { subscriptionFor } from "../claude-code";
import { ErrorBody } from "../error";
import { deleteUserKey, saveUserKey, userKeyHint } from "../user-keys";

const ClaudeSetup = z
  .object({
    /** Which Claude this user's agent work uses now. */
    using: z.enum(["subscription", "own_key", "server_key", "none"]),
    /** Last four characters of their saved API key, if any. */
    keyHint: z.string().nullable(),
    /** Whether this server can save keys (SECRETS_KEY is set). */
    canSave: z.boolean(),
  })
  .openapi("ClaudeSetup");

const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

const getRoute = createRoute({
  method: "get",
  path: "/api/me/claude",
  summary: "How the signed-in user's agent work reaches Claude",
  responses: { 200: { description: "Current setup", content: { "application/json": { schema: ClaudeSetup } } }, 401: err("Not signed in") },
});

const putRoute = createRoute({
  method: "put",
  path: "/api/me/claude",
  summary: "Save the signed-in user's own Anthropic API key (stored encrypted, never returned)",
  request: { body: { content: { "application/json": { schema: z.object({ apiKey: z.string().min(1).max(400) }) } }, required: true } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: ClaudeSetup } } },
    400: err("Not an Anthropic API key, or a subscription token"),
    401: err("Not signed in"),
    503: err("This server cannot save keys (SECRETS_KEY)"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/me/claude",
  summary: "Remove the signed-in user's saved API key",
  responses: { 200: { description: "Removed", content: { "application/json": { schema: ClaudeSetup } } }, 401: err("Not signed in") },
});

async function setup(env: Bindings, user: { id: string; login: string }): Promise<z.infer<typeof ClaudeSetup>> {
  const keyHint = await userKeyHint(env, user.id);
  const serverKey = !!env.ANTHROPIC_API_KEY?.trim() || !!env.CF_AIG_TOKEN?.trim();
  const using = subscriptionFor(env, user.login) ? "subscription" : keyHint && env.SECRETS_KEY ? "own_key" : serverKey ? "server_key" : "none";
  return { using, keyHint, canSave: !!env.SECRETS_KEY?.trim() };
}

export function registerClaude(app: OpenAPIHono<AppEnv>) {
  app.openapi(getRoute, async (c) => c.json(await setup(c.env, await requireUser(c)), 200));
  app.openapi(putRoute, async (c) => {
    const user = await requireUser(c);
    await saveUserKey(c.env, user.id, c.req.valid("json").apiKey);
    return c.json(await setup(c.env, user), 200);
  });
  app.openapi(deleteRoute, async (c) => {
    const user = await requireUser(c);
    await deleteUserKey(c.env, user.id);
    return c.json(await setup(c.env, user), 200);
  });
}
