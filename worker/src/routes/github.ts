import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
import { clearCookie, cookieOptions, getCookie, githubConfig, randomToken, requireUser, setCookie, STATE_MAX_AGE_SECS } from "../auth";
import { appConfig, ghHeaders, installationToken, type AppConfig } from "../github-app";

const INSTALL_STATE_COOKIE = "spectrace_install_state";
const PAGE_SIZE = 100;

const RepoSchema = z
  .object({
    id: z.number().int(),
    installation_id: z.number().int(),
    owner: z.string(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
    default_branch: z.string(),
    html_url: z.string(),
  })
  .openapi("GithubRepo");
type Repo = z.infer<typeof RepoSchema>;

const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

const installRoute = createRoute({
  method: "get",
  path: "/api/github/install",
  summary: "Start installing the GitHub App (redirects to GitHub)",
  responses: { 303: { description: "Redirect to GitHub's install page" }, 401: err("Not signed in"), 500: err("App not configured") },
});

const installCallbackRoute = createRoute({
  method: "get",
  path: "/api/github/install/callback",
  summary: "GitHub redirects back here after the App is installed",
  request: {
    query: z.object({
      installation_id: z.coerce.number().int().optional(),
      setup_action: z.string().optional(),
      code: z.string().optional(),
      state: z.string().optional(),
    }),
  },
  responses: {
    303: { description: "Redirect to /?github_app=installed (or =requested)" },
    400: err("Bad request"),
    401: err("Not signed in"),
    502: err("GitHub failed"),
  },
});

const reposRoute = createRoute({
  method: "get",
  path: "/api/github/repos",
  summary: "Repositories the signed-in user's installations can reach",
  responses: {
    200: { description: "Repositories, sorted by full name", content: { "application/json": { schema: z.array(RepoSchema) } } },
    401: err("Not signed in"),
    502: err("GitHub failed"),
  },
});

async function ghJson<T>(what: string, url: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: ghHeaders(token) });
  } catch (cause) {
    throw new AppError("upstream", `GitHub ${what}: ${String(cause)}`, { cause });
  }
  if (!res.ok) throw new AppError("upstream", `GitHub ${what}: status ${res.status}`);
  return (await res.json()) as T;
}

interface GhInstallation {
  id: number;
  repository_selection: string;
  account: { id: number; login: string; type: string };
}

async function installationRepos(app: AppConfig, installationId: number, token: string): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; ; page++) {
    const batch = await ghJson<{
      repositories: { id: number; name: string; full_name: string; private: boolean; default_branch: string; html_url: string; owner: { login: string } }[];
    }>("repositories request", `${app.apiUrl}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, token);
    for (const r of batch.repositories) {
      out.push({
        id: r.id,
        installation_id: installationId,
        owner: r.owner.login,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        html_url: r.html_url,
      });
    }
    if (batch.repositories.length < PAGE_SIZE) return out;
  }
}

export function registerGithub(app: OpenAPIHono<AppEnv>) {
  app.openapi(installRoute, async (c) => {
    await requireUser(c);
    const cfg = appConfig(c);
    const gh = githubConfig(c);
    const state = randomToken();
    const url = new URL(`${cfg.webUrl}/apps/${encodeURIComponent(cfg.slug)}/installations/new`);
    url.searchParams.set("state", state);
    setCookie(c, INSTALL_STATE_COOKIE, state, cookieOptions(gh.secureCookies, STATE_MAX_AGE_SECS));
    return c.redirect(url.toString(), 303);
  });

  app.openapi(installCallbackRoute, async (c) => {
    const user = await requireUser(c);
    const cfg = appConfig(c);
    const gh = githubConfig(c);
    const { installation_id, setup_action, code, state } = c.req.valid("query");

    const expected = getCookie(c, INSTALL_STATE_COOKIE);
    if (!expected || expected !== state) throw AppError.badRequest("install state does not match");
    clearCookie(c, INSTALL_STATE_COOKIE, gh.secureCookies);

    // An org member who may not install asks the owners instead; nothing to record until an owner approves.
    if (setup_action === "request") return c.redirect("/?github_app=requested", 303);

    if (installation_id === undefined || !code) {
      throw AppError.badRequest('missing installation_id or code (enable "Request user authorization (OAuth) during installation" on the GitHub App)');
    }

    // Anyone can type any installation id into this URL. Only record installations GitHub lists for the signed-in person.
    let token: string | undefined;
    try {
      const res = await fetch(`${gh.oauthUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: gh.clientId, client_secret: gh.clientSecret, code }),
      });
      token = ((await res.json()) as { access_token?: string }).access_token;
    } catch (cause) {
      throw new AppError("upstream", `GitHub token request: ${String(cause)}`, { cause });
    }
    if (!token) throw AppError.badRequest("GitHub did not accept the authorization code");

    const who = await ghJson<{ id: number }>("user request", `${cfg.apiUrl}/user`, token);
    if (who.id !== user.github_id) throw AppError.badRequest("that GitHub authorization belongs to a different user");

    let inst: GhInstallation | undefined;
    for (let page = 1; !inst; page++) {
      const batch = await ghJson<{ installations: GhInstallation[] }>(
        "installations request",
        `${cfg.apiUrl}/user/installations?per_page=${PAGE_SIZE}&page=${page}`,
        token,
      );
      inst = batch.installations.find((i) => i.id === installation_id);
      if (batch.installations.length < PAGE_SIZE) break;
    }
    if (!inst) throw AppError.badRequest("that installation is not available to your GitHub account");

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (id) DO UPDATE
           SET account_id = excluded.account_id, account_login = excluded.account_login,
               account_type = excluded.account_type, repository_selection = excluded.repository_selection,
               updated_at = excluded.updated_at`,
      ).bind(inst.id, inst.account.id, inst.account.login, inst.account.type, inst.repository_selection, now),
      c.env.DB.prepare("INSERT OR IGNORE INTO user_installations (user_id, installation_id, created_at) VALUES (?1, ?2, ?3)").bind(user.id, inst.id, now),
    ]);
    return c.redirect("/?github_app=installed", 303);
  });

  app.openapi(reposRoute, async (c) => {
    const user = await requireUser(c);
    const cfg = appConfig(c);
    const { results } = await c.env.DB.prepare("SELECT installation_id FROM user_installations WHERE user_id = ?1 ORDER BY installation_id")
      .bind(user.id)
      .all<{ installation_id: number }>();

    const repos: Repo[] = [];
    for (const { installation_id } of results) {
      const token = await installationToken(cfg, installation_id);
      if (!token) {
        // GitHub no longer knows this installation (uninstalled): forget it.
        await c.env.DB.prepare("DELETE FROM github_installations WHERE id = ?1").bind(installation_id).run();
        continue;
      }
      repos.push(...(await installationRepos(cfg, installation_id, token)));
    }
    repos.sort((a, b) => (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0));
    return c.json(repos, 200);
  });
}
