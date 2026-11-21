import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "./schema";
import { api } from "./client";

export type User = components["schemas"]["User"];
export type Project = components["schemas"]["Project"];

/** A repository GitHub lets the user pick (`GET /api/github/repos`, from the GitHub App installation). */
export type GithubRepo = components["schemas"]["GithubRepo"];

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
  });
}

export const keys = { me: ["me"] as const, projects: ["projects"] as const, githubRepos: ["github-repos"] as const };

/** The signed-in user, or `null` when there is no session (401). */
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async (): Promise<User | null> => {
      const { data, response } = await api.GET("/api/me");
      if (response.status === 401) return null;
      if (!data) throw new Error(`GET /api/me failed (${response.status})`);
      return data;
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.POST("/api/auth/logout");
    },
    onSuccess: () => qc.setQueryData(keys.me, null),
  });
}

function apiError(error: unknown, fallback: string): Error {
  const message = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(message ?? fallback);
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: async (): Promise<Project[]> => {
      const { data, error } = await api.GET("/api/projects");
      if (!data) throw apiError(error, "Could not load your projects.");
      return data;
    },
  });
}

export type NewProject = {
  name: string;
  context: string;
  repos: { full_name: string; github_repo_id?: number; default_branch?: string }[];
};

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: NewProject): Promise<Project> => {
      const { data, error } = await api.POST("/api/projects", { body });
      if (!data) throw apiError(error, "Could not create the project.");
      return data;
    },
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(keys.projects, (old) => [...(old ?? []), project]);
    },
  });
}

/**
 * Repos from the user's GitHub App installation, for the suggestion chips. Empty when the App is
 * not installed or not configured: typing owner/repo or pasting a link still works.
 */
export function useGithubRepos() {
  return useQuery({
    queryKey: keys.githubRepos,
    queryFn: async (): Promise<GithubRepo[]> => {
      try {
        const { data } = await api.GET("/api/github/repos");
        return data ?? [];
      } catch {
        return [];
      }
    },
  });
}
