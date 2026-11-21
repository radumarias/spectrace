import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

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
