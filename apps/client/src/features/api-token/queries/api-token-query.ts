import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  createApiToken,
  getApiTokens,
  ICreateApiTokenRequest,
  revokeApiToken,
} from "@/features/api-token/services/api-token-service";

const API_TOKENS_KEY = ["api-tokens"];

export function useApiTokensQuery() {
  return useQuery({ queryKey: API_TOKENS_KEY, queryFn: getApiTokens });
}

export function useCreateApiTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ICreateApiTokenRequest) => createApiToken(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: API_TOKENS_KEY });
    },
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message ?? "Failed to create token",
        color: "red",
      });
    },
  });
}

export function useRevokeApiTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeApiToken(id),
    onSuccess: () => {
      notifications.show({ message: "Token revoked" });
      queryClient.invalidateQueries({ queryKey: API_TOKENS_KEY });
    },
    onError: () => {
      notifications.show({ message: "Failed to revoke token", color: "red" });
    },
  });
}
