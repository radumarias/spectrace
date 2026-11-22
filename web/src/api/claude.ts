import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { components } from "./schema";

/** How the signed-in user's agent work reaches Claude (`GET /api/me/claude`). */
export type ClaudeSetup = components["schemas"]["ClaudeSetup"];

const key = ["me", "claude"] as const;

function apiError(error: unknown, fallback: string): Error {
  const message = (error as { error?: { message?: string } } | undefined)?.error?.message;
  return new Error(message || fallback);
}

export function useClaudeSetup() {
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<ClaudeSetup> => {
      const { data, error } = await api.GET("/api/me/claude");
      if (!data) throw apiError(error, "Could not load your Claude setup.");
      return data;
    },
  });
}

export function useSaveClaudeKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (apiKey: string): Promise<ClaudeSetup> => {
      const { data, error } = await api.PUT("/api/me/claude", { body: { apiKey } });
      if (!data) throw apiError(error, "Could not save the key.");
      return data;
    },
    onSuccess: (setup) => qc.setQueryData(key, setup),
  });
}

export function useRemoveClaudeKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ClaudeSetup> => {
      const { data, error } = await api.DELETE("/api/me/claude");
      if (!data) throw apiError(error, "Could not remove the key.");
      return data;
    },
    onSuccess: (setup) => qc.setQueryData(key, setup),
  });
}
