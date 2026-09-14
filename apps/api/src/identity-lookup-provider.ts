export type ResolvedProviderIdentity = {
  provider: string;
  providerUserId: string;
  username: string;
};

export interface IdentityLookupProvider {
  readonly provider: string;
  resolveLogin(login: string): Promise<ResolvedProviderIdentity | null>;
}

export class IdentityLookupProviderError extends Error {
  constructor() {
    super("Identity provider lookup failed");
    this.name = "IdentityLookupProviderError";
  }
}
