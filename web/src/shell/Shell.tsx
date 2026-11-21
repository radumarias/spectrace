import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { getCurrentProjectId } from "../api/current";
import { IndexLive } from "../api/live";
import { usePulls } from "../api/pulls";
import { useMe, useProjects, useSignOut } from "../api/queries";
import { useTheme } from "../theme";
import { Button } from "../ui/parts";
import { Icon } from "../ui/Icon";
import { GROUPS, ROOT_ROUTES, TABS } from "./nav";

/** Badge counts come from the API; pages without data of their own get none. */
function Badge({ id, needs }: { id: string; needs: number }) {
  return (id === "home" || id === "prs") && needs > 0 ? <span className="bd">{needs}</span> : null;
}

export function Shell() {
  const { pathname } = useLocation();
  const route = pathname.split("/")[1] ?? "";
  const root = ROOT_ROUTES.includes(route);
  const { theme, toggle } = useTheme();
  const [askOpen, setAskOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const me = useMe().data;
  const signOut = useSignOut();
  const projects = useProjects().data;
  const current = projects?.find((p) => p.id === getCurrentProjectId()) ?? projects?.[0];
  const needs = usePulls(current?.id, "needs", null).data?.counts.needs ?? 0;
  const repoWord = (n: number) => `${n} ${n === 1 ? "repo" : "repos"}`;

  useEffect(() => {
    if (main.current) main.current.scrollTop = 0;
    setAskOpen(false);
  }, [pathname]);

  return (
    <div className={root ? "shell root" : "shell"}>
      <header className="top">
        <NavLink className="brand" to="/projects" aria-label="spectrace home">
          <svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true">
            <circle cx="5" cy="13" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="21" cy="6" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="21" cy="20" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 12 L18 7 M8 14 L18 19" stroke="currentColor" strokeWidth="1.8" fill="none" />
          </svg>
          spectrace
        </NavLink>
        <NavLink className="repo" to="/projects" style={{ textDecoration: "none" }}>
          {root || !current ? "All projects" : `${current.name} · ${repoWord(current.repos.length)}`}
        </NavLink>
        <span className="grow" />
        <Button small onClick={toggle} aria-label="Switch light or dark theme">
          {theme === "dark" ? "Light" : "Dark"}
        </Button>
        <Button variant="primary" small aria-expanded={askOpen} aria-controls="ask" onClick={() => setAskOpen((o) => !o)}>
          <span className="lab">Ask the </span>coordinator
        </Button>
        {me && (
          <button
            type="button"
            className="avatar"
            title={`Signed in as ${me.login}. Click to sign out.`}
            aria-label={`Signed in as ${me.login}. Sign out`}
            onClick={() => signOut.mutate()}
          >
            {me.avatar_url ? <img src={me.avatar_url} alt="" /> : me.login.slice(0, 2).toUpperCase()}
          </button>
        )}
      </header>

      {!root && (
        <nav className="side" aria-label="Main">
          <NavLink to="/projects" className="back">
            <Icon name="back" size={16} />
            <span>All projects</span>
          </NavLink>
          <div className="side-proj">
            <span className="mark">{(current?.name.trim()[0] ?? "?").toUpperCase()}</span>
            <div className="stack-s" style={{ gap: 1, minWidth: 0 }}>
              <b>{current?.name ?? "Project"}</b>
              <span className="mono sub" style={{ fontSize: 11 }}>{current?.repos[0]?.full_name ?? ""}</span>
            </div>
          </div>
          {GROUPS.map((g) => (
            <div key={g.title} style={{ display: "contents" }}>
              <span className="sect">{g.title}</span>
              {g.items.map((it) => (
                <NavLink key={it.id} to={`/${it.id}`} className={({ isActive }) => (isActive || (it.id === "prs" && route === "pr") ? "on" : "")}>
                  <Icon name={it.id} />
                  <span>{it.label}</span>
                  <Badge id={it.id} needs={needs} />
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      )}

      {projects?.map((p) => <IndexLive key={p.id} project={p} />)}

      <main ref={main} tabIndex={-1}>
        <Outlet />
      </main>

      <aside className="ask" id="ask" aria-label="Coordinator" hidden={!askOpen}>
        <div className="ask-h">
          <b style={{ font: "600 16px var(--f-display)" }}>Coordinator</b>
          <Button variant="ghost" small onClick={() => setAskOpen(false)}>Close</Button>
        </div>
        <div className="msgs" aria-live="polite">
          <div className="msg">
            <span className="by">Coordinator</span>
            Hi. I can see what you are looking at, and I can act on anything you can click. Ask me what needs you, or tell me what to change.
          </div>
        </div>
        <form className="composer" onSubmit={(e) => e.preventDefault()}>
          <label className="sr" htmlFor="ask-input">Message the coordinator</label>
          <input id="ask-input" autoComplete="off" placeholder="Ask, or say what to change…" />
          <Button variant="primary" type="submit">Send</Button>
        </form>
      </aside>

      {!root && (
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={`/${t.id}`}
              className={({ isActive }) => (isActive || t.also?.includes(route) ? "on" : "")}
            >
              <Icon name={t.id} size={22} />
              {t.label}
              <Badge id={t.id} needs={needs} />
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
