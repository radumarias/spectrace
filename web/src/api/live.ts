import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { boardKeys } from "./boards";
import { pullKeys } from "./pulls";
import { keys, type Project } from "./queries";
import { reqKeys } from "./requirements";

/** One job event, as the Worker sends it over the project's WebSocket. */
export type JobEvent = { id: number; projectId: string; jobId: string; event: string; data: Record<string, unknown>; createdAt: string };

export const isIndexing = (p: Project) => p.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * One WebSocket to a project's event feed (`/api/projects/{id}/events`).
 * Events are handed over once each, also across reconnects (the feed replays
 * from the last id seen). A lost connection is reopened with a growing wait;
 * `onReconnect` runs after every open but the first, to catch up on whatever
 * the page could not hear in between. Closes when `enabled` turns false.
 */
function useProjectSocket(id: string | undefined, enabled: boolean, onEvent: (ev: JobEvent) => void, onReconnect: () => void) {
  useEffect(() => {
    if (!id || !enabled || typeof WebSocket === "undefined") return;
    let ws: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;
    let last: number | undefined;
    let opened = false;
    let wait = MIN_RETRY_MS;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const after = last === undefined ? "" : `?after=${last}`;
      ws = new WebSocket(`${proto}//${location.host}/api/projects/${encodeURIComponent(id)}/events${after}`);
      ws.onopen = () => {
        wait = MIN_RETRY_MS;
        if (opened) onReconnect();
        opened = true;
      };
      ws.onmessage = (m) => {
        let ev: JobEvent;
        try {
          ev = JSON.parse(String(m.data)) as JobEvent;
        } catch {
          return;
        }
        if (ev.id < 0) return onEvent(ev); // a live studio event: never stored, so never replayed or repeated
        if (last !== undefined && ev.id <= last) return; // seen around a reconnect
        last = ev.id;
        onEvent(ev);
      };
      ws.onclose = () => {
        if (closed) return;
        timer = window.setTimeout(open, wait);
        wait = Math.min(wait * 2, MAX_RETRY_MS);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
    // The handlers only touch the query client, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);
}

const refreshProjects = (qc: QueryClient) => void qc.invalidateQueries({ queryKey: keys.projects });

/** Everything a page shows about this project's pull requests. */
function refreshPulls(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: pullKeys.all(projectId) });
  for (const k of ["pull", "pull-diff", "pull-reviews", "agent-review"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
}

/** Someone (you, on any device) asked the coordinator something and it is still working on it. */
export type StudioThinking = { userId: string; boardId: string | null; setId: string | null; at: number };
export const studioKey = (projectId: string) => ["studio-thinking", projectId] as const;
/** A question older than this is taken as lost (its end was never heard). */
export const THINKING_MS = 5 * 60_000;

/**
 * Live studio events: the coordinator thinking, new messages, and a board or
 * requirements set that changed (by the coordinator, an undo, or a hand edit
 * on another device). A page already showing that version reads nothing.
 */
function onStudio(qc: QueryClient, projectId: string, ev: JobEvent) {
  const d = ev.data;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (ev.event === "studio.thinking") {
    const at = Date.now();
    qc.setQueryData<StudioThinking>(studioKey(projectId), { userId: str(d.userId) ?? "", boardId: str(d.boardId), setId: str(d.setId), at });
    window.setTimeout(() => {
      if (qc.getQueryData<StudioThinking | null>(studioKey(projectId))?.at === at) qc.setQueryData(studioKey(projectId), null);
    }, THINKING_MS);
  } else if (ev.event === "studio.messages") {
    qc.setQueryData(studioKey(projectId), null);
    void qc.invalidateQueries({ queryKey: ["coordinator", projectId] });
  } else if (ev.event === "studio.board" && str(d.boardId)) {
    const k = boardKeys.one(projectId, str(d.boardId)!);
    if (qc.getQueryData<{ updatedAt: string }>(k)?.updatedAt !== d.updatedAt) void qc.invalidateQueries({ queryKey: k, exact: true });
    void qc.invalidateQueries({ queryKey: boardKeys.all(projectId), exact: true });
  } else if (ev.event === "studio.requirements" && str(d.setId)) {
    const k = reqKeys.one(projectId, str(d.setId)!);
    if (qc.getQueryData<{ updatedAt: string }>(k)?.updatedAt !== d.updatedAt) void qc.invalidateQueries({ queryKey: k, exact: true });
    void qc.invalidateQueries({ queryKey: reqKeys.all(projectId), exact: true });
  }
}

/** The question the coordinator is working on right now, asked from any of your devices; null when it is free. */
export function useStudioThinking(projectId: string | undefined): StudioThinking | null {
  const { data } = useQuery({
    queryKey: studioKey(projectId ?? ""),
    queryFn: (): StudioThinking | null => null,
    enabled: false,
    initialData: null,
    staleTime: Infinity,
  });
  return data ?? null;
}

/**
 * While a project is being indexed, listen to its live events and refetch the
 * projects when something changes, so the progress banner and the project card
 * move on their own. The socket closes when indexing ends or the page goes.
 */
export function useIndexLive(project: Project | undefined) {
  const qc = useQueryClient();
  useProjectSocket(project?.id, project ? isIndexing(project) : false, () => refreshProjects(qc), () => refreshProjects(qc));
}

/**
 * The project the person is working in stays connected: a webhook that
 * changes a pull request (`pr.updated`, `repo.pushed`) refreshes the inbox and
 * the open detail page, and a finished job refreshes the projects and the
 * pull requests, so nothing needs a reload.
 */
export function useProjectLive(project: Project | undefined) {
  const qc = useQueryClient();
  const id = project?.id;
  useProjectSocket(
    id,
    true,
    (ev) => {
      if (!id) return;
      if (ev.event.startsWith("studio.")) onStudio(qc, id, ev);
      else if (ev.event === "pr.updated" || ev.event === "repo.pushed") refreshPulls(qc, id);
      else if (ev.event === "progress" && typeof ev.data.review === "string") void qc.invalidateQueries({ queryKey: ["agent-review", id] }); // a review moved to its next stage
      else {
        refreshProjects(qc);
        if (ev.event === "succeeded") {
          refreshPulls(qc, id); // a sync that finished brings new and changed PRs
          void qc.invalidateQueries({ queryKey: ["specs", id] }); // and an index brings new specs
        }
        if (ev.event === "failed") void qc.invalidateQueries({ queryKey: ["agent-review", id] }); // a review that gave up says why
      }
    },
    () => {
      if (!id) return;
      refreshProjects(qc);
      refreshPulls(qc, id);
      // Studio events are not replayed: read what may have changed while away.
      qc.setQueryData(studioKey(id), null);
      for (const k of [["coordinator", id], boardKeys.all(id), reqKeys.all(id)]) void qc.invalidateQueries({ queryKey: k });
    },
  );
}

/** Renders nothing; keeps the live connection of one project open while it is indexing. */
export function IndexLive({ project }: { project: Project }) {
  useIndexLive(project);
  return null;
}

/** Renders nothing; keeps the live connection of the current project open. */
export function ProjectLive({ project }: { project: Project }) {
  useProjectLive(project);
  return null;
}
