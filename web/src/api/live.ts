import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { keys, type Project } from "./queries";

/** One job event, as the Worker sends it over the project's WebSocket. */
export type JobEvent = { id: number; projectId: string; jobId: string; event: string; data: Record<string, unknown>; createdAt: string };

export const isIndexing = (p: Project) => p.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");

const RECONNECT_MS = 3000;

/**
 * While a project is being indexed, listen to its live events and refetch the
 * projects when something changes, so the progress banner and the project card
 * move on their own. The socket closes when indexing ends or the page goes.
 */
export function useIndexLive(project: Project | undefined) {
  const qc = useQueryClient();
  const id = project?.id;
  const active = project ? isIndexing(project) : false;

  useEffect(() => {
    if (!id || !active || typeof WebSocket === "undefined") return;
    let ws: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;
    let last: number | undefined;
    const refresh = () => void qc.invalidateQueries({ queryKey: keys.projects });

    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const after = last === undefined ? "" : `?after=${last}`;
      ws = new WebSocket(`${proto}//${location.host}/api/projects/${encodeURIComponent(id)}/events${after}`);
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(String(m.data)) as JobEvent;
          if (last !== undefined && ev.id <= last) return; // seen around a reconnect
          last = ev.id;
        } catch {
          return;
        }
        refresh();
      };
      ws.onopen = refresh; // anything that happened before the socket opened
      ws.onclose = () => {
        if (!closed) timer = window.setTimeout(open, RECONNECT_MS);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [id, active, qc]);
}

/** Renders nothing; keeps the live connection of one project open while it is indexing. */
export function IndexLive({ project }: { project: Project }) {
  useIndexLive(project);
  return null;
}
