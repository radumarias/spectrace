// The app map (T6.5), as in the prototype's `#map`: the app's areas and
// features around it, coloured by their roll-up; click a node for its roll-up,
// open an area to zoom in, open a feature to reach its spec. `/map?area=<path>&sel=<node>`.
import { useMemo } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { useSpecs } from "../api/specs";
import { Button, Card, Pill } from "../ui/parts";
import { Diagram } from "../spec/Diagram";
import { MAP_STATUS_LABEL, MAP_STATUS_TONE, mapLevel, titleOf, type MapStatus } from "../spec/map";

const DOT: Record<MapStatus, string> = { ok: "var(--ok)", warn: "var(--warn)", idle: "var(--idle)", bad: "var(--bad)" };

export function AppMap() {
  const { project, isPending } = useCurrentProject();
  const specs = useSpecs(project?.id);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const path = params.get("area") ?? "";
  const level = useMemo(() => mapLevel(specs.data ?? [], path, project?.name ?? "App"), [specs.data, path, project?.name]);
  const status = useMemo(() => ({ root: "root" as const, ...Object.fromEntries(level.nodes.map((n) => [n.key, n.roll.status])) }), [level]);

  if (isPending || specs.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  if (specs.error) return <div className="page"><Card><p className="err">{specs.error.message}</p></Card></div>;

  const go = (area: string, sel?: string) => {
    const n = new URLSearchParams();
    if (area) n.set("area", area);
    if (sel) n.set("sel", sel);
    setParams(n);
  };
  const selKey = params.get("sel");
  const sel = level.nodes.find((n) => n.key === selKey) ?? null;
  const roll = sel ? sel.roll : level.root;
  const label = sel ? sel.label : level.title;
  const pct = roll.requirements ? Math.round((100 * roll.tested) / roll.requirements) : 0;
  const open = sel
    ? sel.kind === "area"
      ? { text: `Zoom into ${sel.label}`, run: () => go(sel.path) }
      : { text: `Open the ${sel.label} spec`, run: () => navigate(`/spec/${sel.specId}`) }
    : null;
  const crumbs = path ? path.split("/") : [];

  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="eyebrow">App map</span>
          <h1>{level.title}</h1>
          <nav className="crumbs" aria-label="Map level">
            <Button variant="ghost" small onClick={() => go("")}>
              {project.name}
            </Button>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: "contents" }}>
                <span>/</span>
                <Button variant="ghost" small onClick={() => go(crumbs.slice(0, i + 1).join("/"))}>
                  {titleOf(c)}
                </Button>
              </span>
            ))}
          </nav>
        </div>
      </div>
      {level.nodes.length === 0 ? (
        <Card>
          <p className="sub">
            No specs yet, so there is nothing to map. Each spec/&lt;area&gt;/&lt;flow&gt;.md in a repo becomes a feature here; see the <Link to="/spec">Spec</Link> page.
          </p>
        </Card>
      ) : (
        <div className="row">
          <div className="main card pad stack">
            <span className="lbl">Click a node to see its roll-up. Open it to zoom in.</span>
            <div className="dia-wrap">
              <Diagram
                source={level.source}
                label={`${level.title} map`}
                status={status}
                selected={sel?.key ?? "root"}
                onSelect={(key) => go(path, key === "root" ? undefined : key)}
                tools={(zoom) => <div className="dia-tools">{zoom}</div>}
              />
            </div>
            <div className="legend">
              {(["ok", "warn", "idle", "bad"] as MapStatus[]).map((s) => (
                <span key={s}>
                  <span className="dot" style={{ background: DOT[s] }} />
                  {MAP_STATUS_LABEL[s]}
                </span>
              ))}
            </div>
          </div>
          <aside className="aside card pad stack" aria-label="Roll-up">
            <span className="lbl">Roll-up</span>
            <h2 style={{ fontSize: 20 }}>{label}</h2>
            <div className="btns">
              <Pill tone={MAP_STATUS_TONE[roll.status]}>{MAP_STATUS_LABEL[roll.status]}</Pill>
              {sel && <Pill tone="idle">{sel.kind === "area" ? "area" : "feature"}</Pill>}
            </div>
            <dl className="kv">
              <dt>Coverage</dt>
              <dd>
                {pct}% · req {roll.tested}/{roll.requirements}
              </dd>
              <dt>Features</dt>
              <dd>{roll.specs}</dd>
              <dt>Steps</dt>
              <dd>{roll.steps}</dd>
              <dt>Errors</dt>
              <dd>{roll.errors ? `${roll.errors} in the spec files` : "none"}</dd>
            </dl>
            {open ? (
              <Button variant="primary" onClick={open.run}>
                {open.text}
              </Button>
            ) : (
              <p className="sub" style={{ fontSize: 13 }}>
                The worst status of any {path ? "feature" : "area"} rolls up here.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
