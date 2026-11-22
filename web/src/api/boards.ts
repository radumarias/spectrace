import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

export type Board = components["schemas"]["Board"];
export type BoardSummary = components["schemas"]["BoardSummary"];
export type BoardInput = components["schemas"]["BoardInput"];

export const boardKeys = {
  all: (projectId: string) => ["boards", projectId] as const,
  one: (projectId: string, boardId: string) => ["boards", projectId, boardId] as const,
};

function message(error: unknown, fallback: string): Error {
  const m = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(m ?? fallback);
}

export function useBoards(projectId: string | undefined) {
  return useQuery({
    queryKey: boardKeys.all(projectId ?? ""),
    enabled: !!projectId,
    queryFn: async (): Promise<BoardSummary[]> => {
      const { data, error } = await api.GET("/api/projects/{projectId}/boards", { params: { path: { projectId: projectId! } } });
      if (!data) throw message(error, "Could not load the boards.");
      return data;
    },
  });
}

/** One board; `null` when it is gone. */
export function useBoard(projectId: string | undefined, boardId: string | undefined) {
  return useQuery({
    queryKey: boardKeys.one(projectId ?? "", boardId ?? ""),
    enabled: Boolean(projectId && boardId),
    staleTime: Infinity, // the page owns the board while it is open; saves write through
    queryFn: async (): Promise<Board | null> => {
      const { data, error, response } = await api.GET("/api/projects/{projectId}/boards/{boardId}", { params: { path: { projectId: projectId!, boardId: boardId! } } });
      if (response.status === 404) return null;
      if (!data) throw message(error, "Could not load the board.");
      return data;
    },
  });
}

export function useCreateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: BoardInput): Promise<Board> => {
      const { data, error } = await api.POST("/api/projects/{projectId}/boards", { params: { path: { projectId } }, body });
      if (!data) throw message(error, "Could not start a board.");
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: boardKeys.all(projectId) }),
  });
}

export function useSaveBoard(projectId: string, boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: BoardInput): Promise<Board> => {
      const { data, error } = await api.PUT("/api/projects/{projectId}/boards/{boardId}", { params: { path: { projectId, boardId } }, body });
      if (!data) throw message(error, "Could not save the board.");
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: boardKeys.all(projectId) }),
  });
}

export function useDeleteBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (boardId: string): Promise<void> => {
      const { error, response } = await api.DELETE("/api/projects/{projectId}/boards/{boardId}", { params: { path: { projectId, boardId } } });
      if (response.status !== 204) throw message(error, "Could not delete the board.");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: boardKeys.all(projectId) }),
  });
}
