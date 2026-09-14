import {
  type IdentityLookupProvider,
  IdentityLookupProviderError,
  type ResolvedProviderIdentity,
} from "./identity-lookup-provider.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

export class GithubIdentityLookupProvider implements IdentityLookupProvider {
  readonly provider = "github";

  constructor(private readonly outboundFetch: typeof fetch) {}

  async resolveLogin(login: string): Promise<ResolvedProviderIdentity | null> {
    if (!LOGIN.test(login)) return null;
    let response: Response;
    try {
      response = await this.outboundFetch(
        `https://api.github.com/users/${encodeURIComponent(login)}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "context-hub",
            "x-github-api-version": "2022-11-28",
          },
          redirect: "error",
        },
      );
    } catch {
      throw new IdentityLookupProviderError();
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new IdentityLookupProviderError();
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const declared = response.headers.get("content-length");
    if (type !== "application/json" && type !== "application/vnd.github+json") {
      throw new IdentityLookupProviderError();
    }
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
      throw new IdentityLookupProviderError();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new IdentityLookupProviderError();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IdentityLookupProviderError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new IdentityLookupProviderError();
    }
    if (!value || typeof value !== "object") throw new IdentityLookupProviderError();
    const identity = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(identity.id) ||
      typeof identity.login !== "string" ||
      !LOGIN.test(identity.login) ||
      identity.login.toLowerCase() !== login.toLowerCase()
    ) {
      throw new IdentityLookupProviderError();
    }
    return {
      provider: this.provider,
      providerUserId: String(identity.id),
      username: identity.login,
    };
  }
}
