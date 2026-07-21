export interface AccessTokenPayload {
  installationId: string;
  expiresAt: number;
}

export interface AuthenticatedRequest {
  installationId: string;
  headers: Record<string, string | string[] | undefined>;
}
