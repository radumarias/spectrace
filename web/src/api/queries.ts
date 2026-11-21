import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "./schema";
import { api } from "./client";

export type User = components["schemas"]["User"];

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
  });
}

export const keys = { me: ["me"] as const };

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
