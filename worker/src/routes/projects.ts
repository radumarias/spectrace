// Projects: a name, some context for the agents, and the repositories the
// project covers. Every route needs a signed-in user and only ever sees that
// user's own projects; someone else's project answers 404, the same as one
// that does not exist, so ids cannot be probed.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireUser } from "../auth";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
import { enqueueIndexes } from "../jobs/index-repo";

const MAX_NAME = 120;
const MAX_CONTEXT = 20_000;
const MAX_REPOS = 50;

const RepoSchema = z
  .object({
    id: z.string(),
    github_repo_id: z.number().int().nullable(),
    full_name: z.string(),
    default_branch: z.string(),
    index_state: z.enum(["pending", "indexing", "ready", "failed"]),
    languages: z.record(z.string(), z.number()),
    file_count: z.number().int().nullable(),
    tree_truncated: z.boolean(),
    indexed_at: z.string().nullable(),
    index_error: z.string().nullable(),
  })
  .openapi("ProjectRepo");

const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    context: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    repos: z.array(RepoSchema),
  })
  .openapi("Project");

const RepoInput = z.object({
  github_repo_id: z.number().int().nullable().optional(),
  full_name: z.string(),
  default_branch: z.string().optional(),
});

const CreateBody = z.object({
  name: z.string(),
  context: z.string().optional(),
  repos: z.array(RepoInput).optional(),
});

/** Omitted fields stay as they are. `repos`, when present, replaces the whole list (repos already attached keep their id and index state). */
const UpdateBody = z.object({
  name: z.string().optional(),
  context: z.string().optional(),
  repos: z.array(RepoInput).optional(),
});

type RepoInputT = z.infer<typeof RepoInput>;
interface CleanRepo {
  github_repo_id: number | null;
  full_name: string;
  default_branch: string | null;
}

const IdParam = z.object({ id: z.string() });
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } });
const err = (description: string) => ({ description, content: json(ErrorBody) });
const errors = { 400: err("Bad request"), 401: err("Not signed in"), 404: err("No such project") };

const listRoute = createRoute({
  method: "get",
  path: "/api/projects",
  summary: "My projects",
  responses: { 200: { description: "Projects with their repositories", content: json(z.array(ProjectSchema)) }, 401: errors[401] },
});
const createProjectRoute = createRoute({
  method: "post",
  path: "/api/projects",
  summary: "Create a project",
  request: { body: { content: json(CreateBody), required: true } },
  responses: { 201: { description: "The new project", content: json(ProjectSchema) }, 400: errors[400], 401: errors[401] },
});
const readRoute = createRoute({
  method: "get",
  path: "/api/projects/{id}",
  summary: "One project",
  request: { params: IdParam },
  responses: { 200: { description: "The project", content: json(ProjectSchema) }, 401: errors[401], 404: errors[404] },
});
const updateRoute = createRoute({
  method: "patch",
  path: "/api/projects/{id}",
  summary: "Change a project",
  request: { params: IdParam, body: { content: json(UpdateBody), required: true } },
  responses: { 200: { description: "The changed project", content: json(ProjectSchema) }, ...errors },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/projects/{id}",
  summary: "Delete a project and its repositories",
  request: { params: IdParam },
  responses: { 204: { description: "Deleted" }, 401: errors[401], 404: errors[404] },
});

const reindexRoute = createRoute({
  method: "post",
  path: "/api/projects/{id}/reindex",
  summary: "Index every repository of the project again",
  request: { params: IdParam },
  responses: { 200: { description: "The project, with its repos back to pending", content: json(ProjectSchema) }, 401: errors[401], 404: errors[404] },
});

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw AppError.badRequest("project name is required");
  if ([...n].length > MAX_NAME) throw AppError.badRequest(`project name is longer than ${MAX_NAME} characters`);
  return n;
}

function checkContext(context: string) {
  if (new TextEncoder().encode(context).length > MAX_CONTEXT) {
    throw AppError.badRequest(`project context is longer than ${MAX_CONTEXT} bytes`);
  }
}

const REPO_PART = /^[A-Za-z0-9._-]+$/;

/** Validate and normalise repos: `owner/name`, no duplicates (case-insensitive). */
function cleanRepos(repos: RepoInputT[]): CleanRepo[] {
  if (repos.length > MAX_REPOS) throw AppError.badRequest(`a project can have at most ${MAX_REPOS} repositories`);
  const seen = new Set<string>();
  return repos.map((r) => {
    const fullName = r.full_name.trim();
    const parts = fullName.split("/");
    if (parts.length !== 2 || !parts.every((p) => REPO_PART.test(p))) {
      throw AppError.badRequest(`repository must look like owner/name, got ${JSON.stringify(fullName)}`);
    }
    if (seen.has(fullName.toLowerCase())) throw AppError.badRequest(`repository ${fullName} is listed twice`);
    seen.add(fullName.toLowerCase());
    const branch = r.default_branch?.trim();
    if (r.default_branch !== undefined && !branch) throw AppError.badRequest("default_branch is empty");
    return { github_repo_id: r.github_repo_id ?? null, full_name: fullName, default_branch: branch ?? null };
  });
}

interface ProjectRow {
  id: string;
  name: string;
  context: string;
  created_at: string;
  updated_at: string;
}
interface RepoRow {
  id: string;
  project_id: string;
  github_repo_id: number | null;
  full_name: string;
  default_branch: string;
  index_state: "pending" | "indexing" | "ready" | "failed";
  languages: string;
  file_count: number | null;
  tree_truncated: number;
  indexed_at: string | null;
  index_error: string | null;
}

const REPO_COLUMNS = "id, project_id, github_repo_id, full_name, default_branch, index_state, languages, file_count, tree_truncated, indexed_at, index_error";

const notFound = (id: string) => AppError.notFound(`project ${id}`);

const toRepo = (r: RepoRow) => ({
  id: r.id,
  github_repo_id: r.github_repo_id,
  full_name: r.full_name,
  default_branch: r.default_branch,
  index_state: r.index_state,
  languages: JSON.parse(r.languages) as Record<string, number>,
  file_count: r.file_count,
  tree_truncated: r.tree_truncated === 1,
  indexed_at: r.indexed_at,
  index_error: r.index_error,
});

/** One project owned by `owner`, with its repos; 404 when missing or someone else's. */
async function load(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare("SELECT id, name, context, created_at, updated_at FROM projects WHERE id = ?1 AND owner_id = ?2")
    .bind(id, owner)
    .first<ProjectRow>();
  if (!row) throw notFound(id);
  const { results } = await db
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM project_repos WHERE project_id = ?1 ORDER BY created_at, full_name`,
    )
    .bind(id)
    .all<RepoRow>();
  return { ...row, repos: results.map(toRepo) };
}

/** For other routes (jobs, ...): resolves only if `owner` owns the project, else 404. */
export async function requireProjectOwner(db: D1Database, owner: string, id: string): Promise<void> {
  const found = await db.prepare("SELECT id FROM projects WHERE id = ?1 AND owner_id = ?2").bind(id, owner).first();
  if (!found) throw notFound(id);
}

const insertRepo = (db: D1Database, projectId: string, r: CleanRepo, now: string) =>
  db
    .prepare(
      `INSERT INTO project_repos (id, project_id, github_repo_id, full_name, default_branch, created_at)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'main'), ?6)`,
    )
    .bind(crypto.randomUUID(), projectId, r.github_repo_id, r.full_name, r.default_branch, now);

export function registerProjects(app: OpenAPIHono<AppEnv>) {
  app.openapi(listRoute, async (c) => {
    const user = await requireUser(c);
    const db = c.env.DB;
    const { results: rows } = await db
      .prepare("SELECT id, name, context, created_at, updated_at FROM projects WHERE owner_id = ?1 ORDER BY created_at, id")
      .bind(user.id)
      .all<ProjectRow>();
    const { results: repos } = await db
      .prepare(
        `SELECT ${REPO_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")}
         FROM project_repos r JOIN projects p ON p.id = r.project_id
         WHERE p.owner_id = ?1 ORDER BY r.created_at, r.full_name`,
      )
      .bind(user.id)
      .all<RepoRow>();
    return c.json(
      rows.map((row) => ({ ...row, repos: repos.filter((r) => r.project_id === row.id).map(toRepo) })),
      200,
    );
  });

  app.openapi(createProjectRoute, async (c) => {
    const user = await requireUser(c);
    const body = c.req.valid("json");
    const name = cleanName(body.name);
    const context = body.context ?? "";
    checkContext(context);
    const repos = cleanRepos(body.repos ?? []);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO projects (id, owner_id, name, context, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)").bind(
        id,
        user.id,
        name,
        context,
        now,
      ),
      ...repos.map((r) => insertRepo(c.env.DB, id, r, now)),
    ]);
    const project = await load(c.env.DB, user.id, id);
    await enqueueIndexes(c.env, id, project.repos.map((r) => r.id));
    return c.json(project, 201);
  });

  app.openapi(readRoute, async (c) => {
    const user = await requireUser(c);
    return c.json(await load(c.env.DB, user.id, c.req.valid("param").id), 200);
  });

  app.openapi(updateRoute, async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const name = body.name === undefined ? null : cleanName(body.name);
    if (body.context !== undefined) checkContext(body.context);
    const repos = body.repos === undefined ? null : cleanRepos(body.repos);
    await requireProjectOwner(c.env.DB, user.id, id);

    const db = c.env.DB;
    const before = new Set((await db.prepare("SELECT id FROM project_repos WHERE project_id = ?1").bind(id).all<{ id: string }>()).results.map((r) => r.id));
    const now = new Date().toISOString();
    const statements = [
      db
        .prepare("UPDATE projects SET name = COALESCE(?2, name), context = COALESCE(?3, context), updated_at = ?4 WHERE id = ?1 AND owner_id = ?5")
        .bind(id, name, body.context ?? null, now, user.id),
    ];
    if (repos) {
      const keep = JSON.stringify(repos.map((r) => r.full_name.toLowerCase()));
      statements.push(
        db
          .prepare("DELETE FROM project_repos WHERE project_id = ?1 AND lower(full_name) NOT IN (SELECT value FROM json_each(?2))")
          .bind(id, keep),
      );
      for (const r of repos) {
        statements.push(
          db
            .prepare(
              `INSERT INTO project_repos (id, project_id, github_repo_id, full_name, default_branch, created_at)
               VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'main'), ?6)
               ON CONFLICT (project_id, full_name) DO UPDATE
                 SET github_repo_id = COALESCE(excluded.github_repo_id, project_repos.github_repo_id),
                     default_branch = COALESCE(?5, project_repos.default_branch)`,
            )
            .bind(crypto.randomUUID(), id, r.github_repo_id, r.full_name, r.default_branch, now),
        );
      }
    }
    await db.batch(statements);
    const project = await load(db, user.id, id);
    // Repos that were not there before get indexed; the ones that stayed keep what they have.
    await enqueueIndexes(c.env, id, project.repos.filter((r) => !before.has(r.id)).map((r) => r.id));
    return c.json(project, 200);
  });

  app.openapi(reindexRoute, async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, id);
    // Repos already waiting or running keep their job; the rest start over.
    const { results } = await c.env.DB.prepare(
      "UPDATE project_repos SET index_state = 'pending', index_error = NULL WHERE project_id = ?1 AND index_state IN ('ready', 'failed') RETURNING id",
    )
      .bind(id)
      .all<{ id: string }>();
    await enqueueIndexes(c.env, id, results.map((r) => r.id));
    return c.json(await load(c.env.DB, user.id, id), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const res = await c.env.DB.prepare("DELETE FROM projects WHERE id = ?1 AND owner_id = ?2").bind(id, user.id).run();
    if (res.meta.changes === 0) throw notFound(id);
    return c.body(null, 204);
  });
}
