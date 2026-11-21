import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

export type SpecSummary = components["schemas"]["SpecSummary"];
export type SpecDetail = components["schemas"]["SpecDetail"];
export type SpecAnchor = components["schemas"]["SpecAnchor"];
export type SpecModel = components["schemas"]["SpecModel"];
export type SpecSection = components["schemas"]["SpecSection"];

export const specKeys = {
  all: (projectId: string) => ["specs", projectId] as const,
  one: (projectId: string, specId: string) => ["specs", projectId, specId] as const,
};

function message(error: unknown, fallback: string): Error {
  const m = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(m ?? fallback);
}

/** The project's specs, as the last index read them (`GET /api/projects/{id}/specs`). */
export function useSpecs(projectId: string | undefined) {
  return useQuery({
    queryKey: specKeys.all(projectId ?? ""),
    enabled: !!projectId,
    queryFn: async (): Promise<SpecSummary[]> => {
      const { data, error } = await api.GET("/api/projects/{projectId}/specs", { params: { path: { projectId: projectId! } } });
      if (!data) throw message(error, "Could not load the specs.");
      return data;
    },
  });
}

/** One spec with its parsed model and anchored code and tests; `null` when it is gone. */
export function useSpec(projectId: string | undefined, specId: string | undefined) {
  return useQuery({
    queryKey: specKeys.one(projectId ?? "", specId ?? ""),
    enabled: Boolean(projectId && specId),
    queryFn: async (): Promise<SpecDetail | null> => {
      const { data, error, response } = await api.GET("/api/projects/{projectId}/specs/{specId}", {
        params: { path: { projectId: projectId!, specId: specId! } },
      });
      if (response.status === 404) return null;
      if (!data) throw message(error, "Could not load the spec.");
      return data;
    },
  });
}
