import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env";
import { log } from "./log";

/** One row of `job_events`, as sent to browsers. */
export interface JobEvent {
  id: number;
  projectId: string;
  jobId: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
}

const REPLAY_LIMIT = 500;

/**
 * One per project (addressed by project id). Browsers connect over WebSocket
 * and receive every job event for the project as a JSON text frame. Uses
 * hibernating WebSockets, so idle connections cost nothing.
 *
 * `GET /<projectId>?after=<event id>` upgrades; events newer than `after` are
 * replayed from D1 first (nothing is replayed when `after` is absent). A frame
 * may arrive twice around a reconnect, so clients de-duplicate on `id`.
 */
export class ProjectHub extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const projectId = decodeURIComponent(url.pathname.slice(1));
    const after = Number(url.searchParams.get("after"));

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    if (url.searchParams.has("after") && Number.isSafeInteger(after) && after >= 0) {
      const { results } = await this.env.DB.prepare(
        "SELECT id, project_id, job_id, event, data, created_at FROM job_events WHERE project_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
      )
        .bind(projectId, after, REPLAY_LIMIT)
        .all<EventRow>();
      for (const row of results) server.send(JSON.stringify(toEvent(row)));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the job consumer (RPC) after it has stored an event. */
  publish(event: JobEvent): void {
    const frame = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch (error) {
        log("warn", "hub send failed", { projectId: event.projectId, error: String(error) }, this.env.LOG_FORMAT);
      }
    }
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients only listen; a text "ping" keeps proxies from timing out.
    if (message === "ping") ws.send("pong");
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code === 1005 ? 1000 : code, reason);
  }
}

export interface EventRow {
  id: number;
  project_id: string;
  job_id: string;
  event: string;
  data: string;
  created_at: string;
}

export function toEvent(row: EventRow): JobEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    event: row.event,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
