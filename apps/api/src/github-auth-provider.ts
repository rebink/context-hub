import {
  type AuthProvider,
  type AuthProviderIdentity,
  AuthProviderResponseError,
} from "./auth-provider.js";

type GithubAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
};

export class GithubAuthProvider implements AuthProvider {
  readonly provider = "github";

  constructor(
    private readonly config: GithubAuthProviderConfig,
    private readonly outboundFetch: typeof fetch,
  ) {}

  authorizationUrl(redirectUri: string, state: string): string {
    const target = new URL("https://github.com/login/oauth/authorize");
    target.searchParams.set("client_id", this.config.clientId);
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("state", state);
    target.searchParams.set("scope", "");
    return target.toString();
  }

  async exchangeCode(code: string): Promise<AuthProviderIdentity> {
    const tokenResponse = await this.outboundFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    if (!tokenResponse.ok) throw new AuthProviderResponseError();
    const tokenReply: unknown = await tokenResponse.json();
    if (
      !tokenReply ||
      typeof tokenReply !== "object" ||
      typeof (tokenReply as { access_token?: unknown }).access_token !== "string" ||
      !(tokenReply as { access_token: string }).access_token
    ) {
      throw new AuthProviderResponseError();
    }
    const accessToken = (tokenReply as { access_token: string }).access_token;

    const identityResponse = await this.outboundFetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "context-hub",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!identityResponse.ok) throw new AuthProviderResponseError();
    const reply: unknown = await identityResponse.json();
    if (!reply || typeof reply !== "object") throw new AuthProviderResponseError();
    const identity = reply as Record<string, unknown>;
    if (
      !Number.isSafeInteger(identity.id) ||
      typeof identity.login !== "string" ||
      identity.login.length === 0
    ) {
      throw new AuthProviderResponseError();
    }

    return {
      provider: this.provider,
      providerUserId: String(identity.id),
      username: identity.login,
      displayName: typeof identity.name === "string" ? identity.name : null,
      avatarUrl: typeof identity.avatar_url === "string" ? identity.avatar_url : null,
    };
  }
}
