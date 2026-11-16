import api from "@/lib/api-client";

export interface IApiToken {
  id: string;
  name: string;
  creatorId: string;
  workspaceId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  token?: string;
}

export interface ICreateApiTokenRequest {
  name: string;
  expiresAt?: string;
}

export async function getApiTokens(): Promise<IApiToken[]> {
  const req = await api.post<IApiToken[]>("/api-tokens");
  return req.data;
}

export async function createApiToken(
  data: ICreateApiTokenRequest,
): Promise<IApiToken> {
  const req = await api.post<IApiToken>("/api-tokens/create", data);
  return req.data;
}

export async function revokeApiToken(apiTokenId: string): Promise<void> {
  await api.post("/api-tokens/revoke", { apiTokenId });
}
