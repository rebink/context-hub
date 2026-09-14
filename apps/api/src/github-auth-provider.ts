import {
  type AuthProvider,
  type AuthProviderIdentity,
  AuthProviderResponseError,
} from "./auth-provider.js";

type GithubAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
};

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

async function rejectGithubResponse(response: Response): Promise<never> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider failures remain one stable application error even when cancellation also fails.
  }
  throw new AuthProviderResponseError();
}

async function readGithubJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return rejectGithubResponse(response);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/vnd.github+json") {
    return rejectGithubResponse(response);
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    return rejectGithubResponse(response);
  }
  if (!response.body) throw new AuthProviderResponseError();

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let parsed: Record<string, unknown> | undefined;
  let failed = false;
  try {
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AuthProviderResponseError();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AuthProviderResponseError();
    }
    parsed = value as Record<string, unknown>;
  } catch {
    failed = true;
    try {
      await reader?.cancel();
    } catch {
      // Cancellation errors are also hidden behind the provider boundary.
    }
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      failed = true;
    }
  }
  if (failed || !parsed) throw new AuthProviderResponseError();
  return parsed;
}

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
    let tokenResponse: Response;
    try {
      tokenResponse = await this.outboundFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
        }),
      });
    } catch {
      throw new AuthProviderResponseError();
    }
    const tokenReply = await readGithubJson(tokenResponse);
    if (typeof tokenReply.access_token !== "string" || !tokenReply.access_token) {
      throw new AuthProviderResponseError();
    }
    const accessToken = tokenReply.access_token;

    let identityResponse: Response;
    try {
      identityResponse = await this.outboundFetch("https://api.github.com/user", {
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "context-hub",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      throw new AuthProviderResponseError();
    }
    const identity = await readGithubJson(identityResponse);
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
