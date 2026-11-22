import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type CoordinatorScreen, useAskCoordinator, useClearCoordinator, useCoordinator, useRunAction, useUndoBoard } from "../api/coordinator";
import { useStudioThinking } from "../api/live";
import { usePull } from "../api/pulls";
import { type Project, useMe } from "../api/queries";
import { Button, Pill } from "../ui/parts";
import { useToast } from "../ui/Toast";
import { TITLES } from "./nav";
import { useDictation, useReadAloud } from "./voice";

const GREETING = "Hi. I can see what you are looking at, and I can act on anything you can click. Ask me what needs you, or tell me what to change.";
const SET_GREETING = "Tell me what to change in these requirements: a step, a requirement, a mockup. I change only that part, and every id that already exists stays the same.";
const BOARD_GREETING = "Tell me what you want to build. I'll ask questions and sketch it on this board as we talk: flows, other diagrams, notes and rough screens. Undo anything I draw with one click.";

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
  board: ["Sketch this flow with me", "Draw it as a sequence diagram", "What is missing?"],
  req: ["Which requirements are not clear yet?", "Add a mockup for each screen", "What is missing?"],
};

/** What the user is looking at, from the URL. */
export function screenOf(pathname: string): CoordinatorScreen {
  const [route = "", id] = pathname.split("/").slice(1);
  const s: CoordinatorScreen = { route: route || "projects" };
  if (id && route === "pr") s.pullId = id;
  if (id && route === "spec") s.specId = id;
  if (id && route === "board") s.boardId = id;
  if (id && route === "req") s.setId = id;
  return s;
}

export function Coordinator({ open, onClose, pathname, project }: { open: boolean; onClose: () => void; pathname: string; project: Project | undefined }) {
  const screen = screenOf(pathname);
  const pid = project?.id ?? "";
  const messages = useCoordinator(project?.id, open);
  const askIt = useAskCoordinator(pid);
  const run = useRunAction(pid);
  const clear = useClearCoordinator(pid);
  const undo = useUndoBoard(pid);
  const pull = usePull(open ? project?.id : undefined, screen.pullId).data;
  const navigate = useNavigate();
  const toast = useToast();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const me = useMe().data;
  const remote = useStudioThinking(project?.id);
  // The coordinator is at work on a question asked here, or on another of your devices.
  const thinking = askIt.isPending ? screen : remote && (!me || remote.userId === me.id) ? remote : null;
  const aloud = useReadAloud();
  const voice = useDictation((heard, final) => {
    if (final) send(heard);
    else setText(heard);
  });

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
    askIt.mutate(
      { text: t, screen },
      {
        onSettled: () => setPending(null),
        onError: (e) => toast(e.message),
        onSuccess: (out) => aloud.speak(out.messages.filter((m) => m.role === "coordinator").at(-1)?.text ?? ""),
      },
    );
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
          {aloud.supported && (
            <Button variant="ghost" small aria-pressed={aloud.on} className={aloud.on ? "on" : undefined} onClick={aloud.toggle} title="Read the coordinator's replies aloud">
              Read aloud
            </Button>
          )}
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
          {!project ? "Open or create a project first. I work inside a project." : screen.boardId ? BOARD_GREETING : screen.setId ? SET_GREETING : GREETING}
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
            {m.board && m.board.changes.length > 0 && (
              <div className="drew" aria-label="Changes to the board">
                {m.board.changes.map((t, i) => (
                  <span className="tool" key={i}>
                    <b>✎</b> {t}
                  </span>
                ))}
                {m.board.undone ? (
                  <span className="mono sub" style={{ fontSize: 11.5 }}>Undone</span>
                ) : (
                  <Button variant="ghost" small disabled={undo.isPending} onClick={() => undo.mutate(m.id, { onError: (e) => toast(e.message) })}>
                    Undo
                  </Button>
                )}
              </div>
            )}
            {m.requirements && (m.requirements.changes.length > 0 || m.requirements.skipped.length > 0) && (
              <div className="drew" aria-label="Changes to the requirements">
                {m.requirements.changes.map((t, i) => (
                  <span className="tool" key={i}>
                    <b>✎</b> {t}
                  </span>
                ))}
                {m.requirements.skipped.map((t, i) => (
                  <span className="tool skip" key={`s${i}`}>
                    <b>✕</b> Not done: {t}
                  </span>
                ))}
                {m.requirements.changes.length > 0 &&
                  (m.requirements.undone ? (
                    <span className="mono sub" style={{ fontSize: 11.5 }}>Undone</span>
                  ) : (
                    <Button variant="ghost" small disabled={undo.isPending} onClick={() => undo.mutate(m.id, { onError: (e) => toast(e.message) })}>
                      Undo
                    </Button>
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
        {thinking && (
          <span className="mono sub" role="status" style={{ fontSize: 12 }}>
            {thinking.boardId ? "coordinator is thinking and sketching…" : thinking.setId ? "coordinator is revising…" : "coordinator is working…"}
          </span>
        )}
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
        <input
          id="ask-input"
          ref={input}
          autoComplete="off"
          placeholder={voice.listening ? "Listening…" : "Ask, or say what to change…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!project}
        />
        {voice.supported && (
          <Button
            className={voice.listening ? "mic on" : "mic"}
            aria-pressed={voice.listening}
            aria-label={voice.listening ? "Stop listening" : "Speak"}
            title={voice.listening ? "Stop listening" : "Speak instead of typing"}
            disabled={!project || askIt.isPending}
            onClick={voice.listening ? voice.stop : voice.start}
          >
            <MicIcon />
          </Button>
        )}
        <Button variant="primary" type="submit" disabled={!project || askIt.isPending || !text.trim()}>
          Send
        </Button>
      </form>
      {voice.error && <p className="err" role="alert" style={{ margin: "0 16px 12px", fontSize: 12.5 }}>{voice.error}</p>}
    </aside>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
