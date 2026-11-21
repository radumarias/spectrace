import { useQuery } from "@tanstack/react-query";
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
