// Live studio events (requirements studio, phase 5).
//
// What the coordinator does on a board or a requirements set reaches every
// device that has the project open, as it happens: "studio.thinking" when a
// question goes in, "studio.messages" when the conversation changed, and
// "studio.board" / "studio.requirements" when the content changed (also by
// hand). They are not stored: each frame has id -1, which clients neither
// de-duplicate nor count as the last event seen, and a client that missed one
// reads everything again when it reconnects.
import type { Bindings } from "./env";
import type { JobEvent } from "./events";
import { log } from "./log";

export type StudioEvent = "studio.thinking" | "studio.messages" | "studio.board" | "studio.requirements";

/** Pushes one studio event to the project's open sockets. Never throws: a missed push is caught up on reconnect. */
export async function studio(env: Bindings, projectId: string, event: StudioEvent, data: Record<string, unknown>): Promise<void> {
  const ev: JobEvent = { id: -1, projectId, jobId: "", event, data, createdAt: new Date().toISOString() };
  try {
    await env.PROJECT_HUB.getByName(projectId).publish(ev);
  } catch (error) {
    log("warn", "studio publish failed", { projectId, event, error: String(error) }, env.LOG_FORMAT);
  }
}
