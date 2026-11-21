import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

export type Pull = components["schemas"]["Pull"];
export type PullCounts = components["schemas"]["PullCounts"];
export type PullFilter = "needs" | "open" | "merged";

export type PullList = { pulls: Pull[]; counts: PullCounts };

export const pullKeys = {
  all: (projectId: string) => ["pulls", projectId] as const,
  list: (projectId: string, filter: PullFilter, repo: string | null) => ["pulls", projectId, filter, repo] as const,
};

function message(error: unknown, fallback: string): Error {
  const m = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(m ?? fallback);
}

/** One inbox tab of a project (`GET /api/projects/{id}/pulls`), optionally for one repo. `counts` always covers every repo. */
export function usePulls(projectId: string | undefined, filter: PullFilter, repo: string | null) {
  return useQuery({
    queryKey: pullKeys.list(projectId ?? "", filter, repo),
    enabled: !!projectId,
    queryFn: async (): Promise<PullList> => {
      const { data, error } = await api.GET("/api/projects/{projectId}/pulls", {
        params: { path: { projectId: projectId! }, query: { filter, ...(repo ? { repo } : {}) } },
      });
      if (!data) throw message(error, "Could not load pull requests.");
      return data;
    },
  });
}

/** "Pull from GitHub": queue a sync. The list is read again when the sync was accepted. */
export function useSyncPulls(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/projects/{projectId}/pulls/sync", { params: { path: { projectId } } });
      if (!data) throw message(error, "Could not start the sync.");
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pullKeys.all(projectId) }),
  });
}

export type PullDetail = components["schemas"]["PullDetail"];
export type PullFile = components["schemas"]["PullFile"];

/** One pull request with its description and changed files (`GET /api/projects/{id}/pulls/{pullId}`). */
export function usePull(projectId: string | undefined, pullId: string | undefined) {
  return useQuery({
    queryKey: ["pull", projectId, pullId] as const,
    enabled: Boolean(projectId && pullId),
    queryFn: async (): Promise<PullDetail> => {
      const { data, response } = await api.GET("/api/projects/{projectId}/pulls/{pullId}", {
        params: { path: { projectId: projectId!, pullId: pullId! } },
      });
      if (!data) throw new Error(response.status === 404 ? "not_found" : `Could not load the pull request (${response.status}).`);
      return data;
    },
  });
}
