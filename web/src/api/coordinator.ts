import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boardKeys } from "./boards";
import { api } from "./client";
import { reqKeys } from "./requirements";
import type { components } from "./schema";

export type CoordinatorMessage = components["schemas"]["CoordinatorMessage"];
export type CoordinatorAction = components["schemas"]["CoordinatorAction"];
export type CoordinatorScreen = components["schemas"]["CoordinatorScreen"];
type CoordinatorBoard = NonNullable<components["schemas"]["CoordinatorBoard"]>;
type RequirementSet = NonNullable<components["schemas"]["RequirementSet"]>;

const key = (projectId: string) => ["coordinator", projectId] as const;

function message(error: unknown, fallback: string): Error {
  const m = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(m || fallback);
}

/** Your conversation with the project's coordinator (`GET /api/projects/{id}/coordinator`). */
export function useCoordinator(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: key(projectId ?? ""),
    enabled: !!projectId && enabled,
    queryFn: async (): Promise<CoordinatorMessage[]> => {
      const { data, error } = await api.GET("/api/projects/{projectId}/coordinator", { params: { path: { projectId: projectId! } } });
      if (!data) throw message(error, "Could not load the conversation.");
      return data.messages;
    },
  });
}

const append = (old: CoordinatorMessage[] | undefined, add: CoordinatorMessage[]) => {
  const byId = new Map((old ?? []).map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()];
};

/** Ask the coordinator; the question and its reply are added to the conversation. */
export function useAskCoordinator(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { text: string; screen: CoordinatorScreen }) => {
      const { data, error } = await api.POST("/api/projects/{projectId}/coordinator", { params: { path: { projectId } }, body: v });
      if (!data) throw message(error, "The coordinator could not answer.");
      return data;
    },
    onSuccess: (out) => {
      qc.setQueryData<CoordinatorMessage[]>(key(projectId), (old) => append(old, out.messages));
      if (out.board) drew(qc, projectId, out.board);
      if (out.requirementSet) revised(qc, projectId, out.requirementSet);
    },
  });
}

/** The coordinator changed a requirements set: the open page shows the new version. */
function revised(qc: ReturnType<typeof useQueryClient>, projectId: string, set: RequirementSet) {
  qc.setQueryData(reqKeys.one(projectId, set.id), set);
  void qc.invalidateQueries({ queryKey: reqKeys.all(projectId), exact: true });
}

/** The coordinator changed a board: the open board page takes the new version. */
function drew(qc: ReturnType<typeof useQueryClient>, projectId: string, board: CoordinatorBoard) {
  qc.setQueryData(boardKeys.one(projectId, board.id), board);
  void qc.invalidateQueries({ queryKey: boardKeys.all(projectId), exact: true });
}

/** Undo the coordinator's change to the whiteboard or the requirements set. */
export function useUndoBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const { data, error } = await api.POST("/api/projects/{projectId}/coordinator/{messageId}/undo", { params: { path: { projectId, messageId } } });
      if (!data) throw message(error, "Could not undo that.");
      return data;
    },
    onSuccess: (out) => {
      qc.setQueryData<CoordinatorMessage[]>(key(projectId), (old) => append(old, out.messages));
      if (out.board) drew(qc, projectId, out.board);
      if (out.requirementSet) revised(qc, projectId, out.requirementSet);
    },
  });
}

/** Run an action the coordinator proposed. Everything it may have changed is read again. */
export function useRunAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: string; index: number }) => {
      const { data, error } = await api.POST("/api/projects/{projectId}/coordinator/{messageId}/actions/{index}", {
        params: { path: { projectId, messageId: v.messageId, index: v.index } },
      });
      if (!data) throw message(error, "That did not work.");
      return data;
    },
    onSuccess: (out) => {
      qc.setQueryData<CoordinatorMessage[]>(key(projectId), (old) => append(old, out.messages));
      if (out.ok) {
        void qc.invalidateQueries({ queryKey: ["pulls", projectId] });
        void qc.invalidateQueries({ queryKey: ["pull", projectId] });
        void qc.invalidateQueries({ queryKey: ["projects"] });
        void qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      }
    },
  });
}

/** Start a new conversation. */
export function useClearCoordinator(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.DELETE("/api/projects/{projectId}/coordinator", { params: { path: { projectId } } });
    },
    onSuccess: () => qc.setQueryData(key(projectId), []),
  });
}
