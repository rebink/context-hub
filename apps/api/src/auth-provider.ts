export type AuthProviderIdentity = {
  provider: string;
  providerUserId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export interface AuthProvider {
  readonly provider: string;
  authorizationUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string): Promise<AuthProviderIdentity>;
}

export class AuthProviderResponseError extends Error {
  constructor() {
    super("Authentication provider returned an invalid response");
    this.name = "AuthProviderResponseError";
  }
}
