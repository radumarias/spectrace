import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "../theme";
import { Button } from "../ui/parts";
import { Icon } from "../ui/Icon";
import { GROUPS, ROOT_ROUTES, TABS } from "./nav";

const BADGES: Record<string, number> = { home: 4, prs: 3, agents: 2 };

function Badge({ id }: { id: string }) {
  return BADGES[id] ? <span className="bd">{BADGES[id]}</span> : null;
}

export function Shell() {
  const { pathname } = useLocation();
  const route = pathname.split("/")[1] ?? "";
  const root = ROOT_ROUTES.includes(route);
  const { theme, toggle } = useTheme();
  const [askOpen, setAskOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

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
          {root ? "All projects" : "Shop app · 1 repo"}
        </NavLink>
        <span className="grow" />
        <div className="usage" title="Claude plan usage, 5-hour window">
          <span className="mono">plan 38%</span>
          <div className="bar" style={{ width: 90 }}>
            <i className="b-acc" style={{ width: "38%" }} />
          </div>
        </div>
        <Button small onClick={toggle} aria-label="Switch light or dark theme">
          {theme === "dark" ? "Light" : "Dark"}
        </Button>
        <Button variant="primary" small aria-expanded={askOpen} aria-controls="ask" onClick={() => setAskOpen((o) => !o)}>
          <span className="lab">Ask the </span>coordinator
        </Button>
        <span className="avatar" aria-label="Signed in as RM">RM</span>
      </header>

      {!root && (
        <nav className="side" aria-label="Main">
          <NavLink to="/projects" className="back">
            <Icon name="back" size={16} />
            <span>All projects</span>
          </NavLink>
          <div className="side-proj">
            <span className="mark">S</span>
            <div className="stack-s" style={{ gap: 1, minWidth: 0 }}>
              <b>Shop app</b>
              <span className="mono sub" style={{ fontSize: 11 }}>xoriors/shop</span>
            </div>
          </div>
          {GROUPS.map((g) => (
            <div key={g.title} style={{ display: "contents" }}>
              <span className="sect">{g.title}</span>
              {g.items.map((it) => (
                <NavLink key={it.id} to={`/${it.id}`} className={({ isActive }) => (isActive ? "on" : "")}>
                  <Icon name={it.id} />
                  <span>{it.label}</span>
                  <Badge id={it.id} />
                </NavLink>
              ))}
            </div>
          ))}
          <div className="live">
            <span className="lbl">Live</span>
            <span>2 agents working on checkout</span>
            <span>$0 API · runs on your plan</span>
          </div>
        </nav>
      )}

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
              <Badge id={t.id} />
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
