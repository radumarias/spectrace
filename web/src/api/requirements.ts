import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

export type RequirementSet = NonNullable<components["schemas"]["RequirementSet"]>;
export type RequirementSetSummary = components["schemas"]["RequirementSetSummary"];
export type RequirementFlow = components["schemas"]["RequirementFlow"];
export type RequirementView = components["schemas"]["RequirementView"];

export const reqKeys = {
  all: (projectId: string) => ["requirements", projectId] as const,
  one: (projectId: string, setId: string) => ["requirements", projectId, setId] as const,
};

function message(error: unknown, fallback: string): Error {
  const m = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(m || fallback);
}

/** The project's requirements sets. */
export function useRequirementSets(projectId: string | undefined) {
  return useQuery({
    queryKey: reqKeys.all(projectId ?? ""),
    enabled: !!projectId,
    queryFn: async (): Promise<RequirementSetSummary[]> => {
      const { data, error } = await api.GET("/api/projects/{projectId}/requirements", { params: { path: { projectId: projectId! } } });
      if (!data) throw message(error, "Could not load the requirements.");
      return data;
    },
  });
}

/** One set; `null` when it is gone. */
export function useRequirementSet(projectId: string | undefined, setId: string | undefined) {
  return useQuery({
    queryKey: reqKeys.one(projectId ?? "", setId ?? ""),
    enabled: Boolean(projectId && setId),
    queryFn: async (): Promise<RequirementSet | null> => {
      const { data, error, response } = await api.GET("/api/projects/{projectId}/requirements/{setId}", { params: { path: { projectId: projectId!, setId: setId! } } });
      if (response.status === 404) return null;
      if (!data) throw message(error, "Could not load the requirements.");
      return data;
    },
  });
}

/** Draft requirements from a whiteboard and the conversation about it. */
export function useDraftRequirements(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (boardId: string): Promise<RequirementSet> => {
      const { data, error } = await api.POST("/api/projects/{projectId}/requirements", { params: { path: { projectId } }, body: { boardId } });
      if (!data) throw message(error, "Could not draft the requirements.");
      return data;
    },
    onSuccess: (set) => {
      qc.setQueryData(reqKeys.one(projectId, set.id), set);
      void qc.invalidateQueries({ queryKey: reqKeys.all(projectId), exact: true });
    },
  });
}

export function useDeleteRequirementSet(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (setId: string) => {
      const { error, response } = await api.DELETE("/api/projects/{projectId}/requirements/{setId}", { params: { path: { projectId, setId } } });
      if (!response.ok) throw message(error, "Could not delete the requirements.");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: reqKeys.all(projectId) }),
  });
}
