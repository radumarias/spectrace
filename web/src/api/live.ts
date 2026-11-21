import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { pullKeys } from "./pulls";
import { keys, type Project } from "./queries";

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
  for (const k of ["pull", "pull-diff", "pull-reviews"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
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
      if (ev.event === "pr.updated" || ev.event === "repo.pushed") refreshPulls(qc, id);
      else {
        refreshProjects(qc);
        if (ev.event === "succeeded") refreshPulls(qc, id); // a sync that finished brings new and changed PRs
      }
    },
    () => {
      if (!id) return;
      refreshProjects(qc);
      refreshPulls(qc, id);
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
