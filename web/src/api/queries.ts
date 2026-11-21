import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "./schema";
import { getCurrentProjectId } from "./current";
import { api } from "./client";

export type User = components["schemas"]["User"];
export type Project = components["schemas"]["Project"];

/** A repository GitHub lets the user pick (`GET /api/github/repos`, from the GitHub App installation). */
export type GithubRepo = { id: number; full_name: string; default_branch: string };

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
    // While any repo is still being indexed, look again every few seconds.
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing")) ? 5000 : false,
  });
}

/** The project the person is working in: the remembered one, else the first. */
export function useCurrentProject() {
  const projects = useProjects();
  const id = getCurrentProjectId();
  const project = projects.data?.find((p) => p.id === id) ?? projects.data?.[0];
  return { project, isPending: projects.isPending, error: projects.error };
}

export type ProjectChange = { name?: string; context?: string; repos?: NewProject["repos"] };

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProjectChange): Promise<Project> => {
      const { data, error } = await api.PATCH("/api/projects/{id}", { params: { path: { id } }, body });
      if (!data) throw apiError(error, "Could not save your changes.");
      return data;
    },
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(keys.projects, (old) => (old ?? []).map((p) => (p.id === project.id ? project : p)));
    },
  });
}

/** Index every repo of the project again (`POST /api/projects/{id}/reindex`). Progress arrives through the live events. */
export function useReindexProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Project> => {
      const { data, error } = await api.POST("/api/projects/{id}/reindex", { params: { path: { id } } });
      if (!data) throw apiError(error, "Could not start re-indexing.");
      return data;
    },
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(keys.projects, (old) => (old ?? []).map((p) => (p.id === project.id ? project : p)));
    },
  });
}

export function useDeleteProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { response, error } = await api.DELETE("/api/projects/{id}", { params: { path: { id } } });
      if (!response.ok) throw apiError(error, "Could not remove the project.");
    },
    onSuccess: () => {
      qc.setQueryData<Project[]>(keys.projects, (old) => (old ?? []).filter((p) => p.id !== id));
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
 * Not in the generated client until T1.2 (`/api/github/repos`) is on main; switch to `api.GET` then.
 */
export function useGithubRepos() {
  return useQuery({
    queryKey: keys.githubRepos,
    queryFn: async (): Promise<GithubRepo[]> => {
      try {
        const res = await fetch("/api/github/repos");
        if (!res.ok) return [];
        const list = (await res.json()) as GithubRepo[];
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },
  });
}
