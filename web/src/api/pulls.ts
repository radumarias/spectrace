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

export type PullDiff = components["schemas"]["PullDiff"];

/** The unified diff of each changed file (`GET /api/projects/{id}/pulls/{pullId}/diff`), loaded when the Files tab opens. */
export function usePullDiff(projectId: string | undefined, pullId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["pull-diff", projectId, pullId] as const,
    enabled: enabled && Boolean(projectId && pullId),
    queryFn: async (): Promise<Map<string, string | null>> => {
      const { data, response } = await api.GET("/api/projects/{projectId}/pulls/{pullId}/diff", {
        params: { path: { projectId: projectId!, pullId: pullId! } },
      });
      if (!data) throw new Error(`Could not load the changes (${response.status}).`);
      return new Map(data.files.map((f) => [f.path, f.patch]));
    },
  });
}

export type PullReview = components["schemas"]["PullReview"];

function apiError(error: unknown, fallback: string): Error {
  const message = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(message ?? fallback);
}

/** The reviews you left from spectrace, newest first. */
export function usePullReviews(projectId: string | undefined, pullId: string | undefined) {
  return useQuery({
    queryKey: ["pull-reviews", projectId, pullId] as const,
    enabled: Boolean(projectId && pullId),
    queryFn: async (): Promise<PullReview[]> => {
      const { data } = await api.GET("/api/projects/{projectId}/pulls/{pullId}/reviews", {
        params: { path: { projectId: projectId!, pullId: pullId! } },
      });
      return data?.reviews ?? [];
    },
  });
}

/** Everything that shows a pull request: this page, its reviews, and the inbox lists. */
function refreshPulls(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ["pull", "pull-reviews", "pulls"]) void qc.invalidateQueries({ queryKey: [key] });
}

export function useReviewPull(projectId: string, pullId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { verdict: "approve" | "request_changes"; body?: string }): Promise<PullReview> => {
      const { data, error } = await api.POST("/api/projects/{projectId}/pulls/{pullId}/reviews", {
        params: { path: { projectId, pullId } },
        body: input,
      });
      if (!data) throw apiError(error, "Could not leave the review.");
      return data;
    },
    onSuccess: () => refreshPulls(qc),
  });
}

export function useMergePull(projectId: string, pullId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/projects/{projectId}/pulls/{pullId}/merge", {
        params: { path: { projectId, pullId } },
      });
      if (!data) throw apiError(error, "Could not merge the pull request.");
      return data;
    },
    onSuccess: () => refreshPulls(qc),
  });
}
