import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type CoordinatorScreen, useAskCoordinator, useClearCoordinator, useCoordinator, useRunAction } from "../api/coordinator";
import { usePull } from "../api/pulls";
import type { Project } from "../api/queries";
import { Button, Pill } from "../ui/parts";
import { useToast } from "../ui/Toast";
import { TITLES } from "./nav";

const GREETING = "Hi. I can see what you are looking at, and I can act on anything you can click. Ask me what needs you, or tell me what to change.";

/** Suggested questions per screen, from the prototype. */
export const SUGG: Record<string, string[]> = {
  projects: ["Which project needs me?"],
  "new-project": ["What should the context say?"],
  project: ["What should the context say?"],
  prs: ["What PRs need me?", "Which PR is riskiest?"],
  home: ["What needs me today?", "What are the agents doing?"],
  map: ["Which areas have no owner?"],
  spec: ["Explain this step", "Why is it risky?"],
  pr: ["Can I merge?", "Summarize this PR", "Why is it risky?"],
  agents: ["What are the agents doing?"],
  risk: ["Why is it risky?"],
  runners: ["What are the agents doing?"],
  talk: ["What needs me today?"],
  board: ["What needs me today?"],
};

/** What the user is looking at, from the URL. */
export function screenOf(pathname: string): CoordinatorScreen {
  const [route = "", id] = pathname.split("/").slice(1);
  const s: CoordinatorScreen = { route: route || "projects" };
  if (id && route === "pr") s.pullId = id;
  if (id && route === "spec") s.specId = id;
  if (id && route === "board") s.boardId = id;
  return s;
}

export function Coordinator({ open, onClose, pathname, project }: { open: boolean; onClose: () => void; pathname: string; project: Project | undefined }) {
  const screen = screenOf(pathname);
  const pid = project?.id ?? "";
  const messages = useCoordinator(project?.id, open);
  const askIt = useAskCoordinator(pid);
  const run = useRunAction(pid);
  const clear = useClearCoordinator(pid);
  const pull = usePull(open ? project?.id : undefined, screen.pullId).data;
  const navigate = useNavigate();
  const toast = useToast();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.data, pending, open]);

  const send = (q: string) => {
    const t = q.trim();
    if (!t || !project || askIt.isPending) return;
    setText("");
    setPending(t);
    askIt.mutate({ text: t, screen }, { onSettled: () => setPending(null), onError: (e) => toast(e.message) });
  };

  const act = (messageId: string, index: number, a: { kind: string; path?: string }) => {
    if (a.kind === "open") {
      if (a.path) navigate(a.path);
      return;
    }
    run.mutate({ messageId, index }, { onError: (e) => toast(e.message) });
  };

  const title = TITLES[screen.route] ?? (screen.route === "pr" ? "Pull request" : screen.route);
  const msgs = messages.data ?? [];

  return (
    <aside className="ask" id="ask" aria-label="Coordinator" hidden={!open}>
      <div className="ask-h">
        <b style={{ font: "600 16px var(--f-display)" }}>Coordinator</b>
        <span className="btns" style={{ gap: 4 }}>
          {msgs.length > 0 && (
            <Button variant="ghost" small onClick={() => clear.mutate()} disabled={clear.isPending || askIt.isPending}>
              New chat
            </Button>
          )}
          <Button variant="ghost" small onClick={onClose}>Close</Button>
        </span>
      </div>
      <div className="ask-ctx">
        {project && <Pill tone="acc">{project.name}</Pill>}
        <Pill tone="idle">here: {title}</Pill>
        {pull && <span className="id">{`${pull.repo.split("/")[1] ?? pull.repo} #${pull.number}`}</span>}
      </div>
      <div className="msgs" aria-live="polite" ref={list}>
        <div className="msg">
          <span className="by">Coordinator</span>
          {project ? GREETING : "Open or create a project first. I work inside a project."}
        </div>
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "user" ? "msg me" : "msg"}>
            <span className="by">{m.role === "user" ? "You" : "Coordinator"}</span>
            {m.text}
            {m.tools.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {m.tools.map((t, i) => (
                  <span className="tool" key={i}>
                    <b>✓</b> {t}
                  </span>
                ))}
              </div>
            )}
            {m.actions.length > 0 && (
              <div className="btns" style={{ marginTop: 8, gap: 6 }}>
                {m.actions.map((a, i) => (
                  <Button key={i} variant="primary" small disabled={m.ran.includes(i) || run.isPending} onClick={() => act(m.id, i, a)}>
                    {m.ran.includes(i) ? `${a.label} ✓` : a.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ))}
        {pending && (
          <div className="msg me">
            <span className="by">You</span>
            {pending}
          </div>
        )}
        {askIt.isPending && <span className="mono sub" style={{ fontSize: 12 }}>coordinator is working…</span>}
      </div>
      {project && (
        <div className="sugg">
          {(SUGG[screen.route] ?? []).map((s) => (
            <button key={s} type="button" className="chip" onClick={() => send(s)} disabled={askIt.isPending}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label className="sr" htmlFor="ask-input">Message the coordinator</label>
        <input id="ask-input" ref={input} autoComplete="off" placeholder="Ask, or say what to change…" value={text} onChange={(e) => setText(e.target.value)} disabled={!project} />
        <Button variant="primary" type="submit" disabled={!project || askIt.isPending || !text.trim()}>
          Send
        </Button>
      </form>
    </aside>
  );
}
