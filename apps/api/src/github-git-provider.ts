import {
  type GitAuthorizationResult,
  type GitProvider,
  GitProviderError,
  type GitRepositoryInspection,
} from "./git-provider.js";

export type GithubGitProviderConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
};

const API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const PRINTABLE_ASCII = /^[ -~]+$/;

function validBranch(value: string): boolean {
  const components = value.split("/");
  return (
    value.length <= 255 &&
    value !== "@" &&
    PRINTABLE_ASCII.test(value) &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !components.some(
      (component) => !component || component.startsWith(".") || component.endsWith(".lock"),
    ) &&
    ![" ", "~", "^", ":", "?", "*", "[", "\\"].some((character) => value.includes(character))
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeJson(value: object): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  const length = derLength(value.byteLength);
  const result = new Uint8Array(1 + length.byteLength + value.byteLength);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.byteLength);
  return result;
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function privateKeyDer(pem: string): ArrayBuffer {
  const pkcs1 = pem.includes("-----BEGIN RSA PRIVATE KEY-----");
  const encoded = pem.replace(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g,
    "",
  );
  const key = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (!pkcs1) return key.slice().buffer;
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return derValue(0x30, concatenate(version, rsaAlgorithm, derValue(0x04, key))).slice().buffer;
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateTarget(installationId: string, owner: string, repository: string): void {
  if (!/^\d{1,20}$/.test(installationId) || !OWNER.test(owner) || !REPOSITORY.test(repository)) {
    throw new GitProviderError("repository-mismatch");
  }
}

function mapStatus(status: number): GitProviderError {
  if (status === 401) return new GitProviderError("unauthorized");
  if (status === 403) return new GitProviderError("forbidden");
  if (status === 404) return new GitProviderError("not-found");
  if (status === 409) return new GitProviderError("conflict");
  if (status === 429) return new GitProviderError("rate-limited");
  return new GitProviderError("unavailable");
}

export class GithubGitProvider implements GitProvider {
  constructor(
    private readonly config: GithubGitProviderConfig,
    private readonly outboundFetch: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  installationUrl(state: string): string {
    const url = new URL(
      `https://github.com/apps/${encodeURIComponent(this.config.appSlug)}/installations/new`,
    );
    url.searchParams.set("state", state);
    return url.toString();
  }

  userAuthorizationUrl(redirectUri: string, state: string, codeChallenge: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async authorizeAndInspect(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    installationId: string;
    owner: string;
    repository: string;
  }): Promise<GitAuthorizationResult> {
    validateTarget(input.installationId, input.owner, input.repository);
    const tokenReply = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    });
    const userToken = this.requiredString(tokenReply, "access_token", 512);
    const user = await this.api("/user", userToken);
    if (!validId(user.id) || typeof user.login !== "string" || !user.login) {
      throw new GitProviderError("invalid-response");
    }
    const installationRepositories = await this.api(
      `/user/installations/${input.installationId}/repositories?per_page=1`,
      userToken,
    );
    if (
      !Number.isSafeInteger(installationRepositories.total_count) ||
      (installationRepositories.total_count as number) < 0 ||
      !Array.isArray(installationRepositories.repositories)
    ) {
      throw new GitProviderError("invalid-response");
    }
    return {
      providerUserId: String(user.id),
      repository: await this.inspectInstallation(input),
    };
  }

  async inspectInstallation(input: {
    installationId: string;
    owner: string;
    repository: string;
  }): Promise<GitRepositoryInspection> {
    validateTarget(input.installationId, input.owner, input.repository);
    const jwt = await this.appJwt();
    const tokenReply = await this.api(
      `/app/installations/${input.installationId}/access_tokens`,
      jwt,
      {
        method: "POST",
        body: JSON.stringify({
          repositories: [input.repository],
          permissions: { metadata: "read", contents: "read" },
        }),
      },
    );
    const installationToken = this.requiredString(tokenReply, "token", 512);
    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;
    const repository = await this.api(path, installationToken);
    if (
      !validId(repository.id) ||
      typeof repository.name !== "string" ||
      typeof repository.full_name !== "string" ||
      typeof repository.default_branch !== "string" ||
      !validBranch(repository.default_branch)
    ) {
      throw new GitProviderError("invalid-response");
    }
    const expected = `${input.owner}/${input.repository}`.toLowerCase();
    if (
      repository.full_name.toLowerCase() !== expected ||
      repository.name.toLowerCase() !== input.repository.toLowerCase()
    ) {
      throw new GitProviderError("repository-mismatch");
    }
    const ref = await this.api(
      `${path}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
      installationToken,
    );
    const object = ref.object;
    if (
      !object ||
      typeof object !== "object" ||
      typeof (object as Record<string, unknown>).sha !== "string"
    ) {
      throw new GitProviderError("invalid-response");
    }
    const headSha = (object as Record<string, unknown>).sha as string;
    if (!SHA.test(headSha)) throw new GitProviderError("invalid-response");
    return {
      provider: "github",
      providerRepositoryId: String(repository.id),
      owner: input.owner.toLowerCase(),
      name: input.repository.toLowerCase(),
      canonicalUrl: `github.com/${input.owner.toLowerCase()}/${input.repository.toLowerCase()}`,
      defaultBranch: repository.default_branch,
      headSha,
    };
  }

  private async appJwt(): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
      iat: issuedAt,
      exp: issuedAt + 540,
      iss: this.config.appId,
    })}`;
    try {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        privateKeyDer(this.config.privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
    } catch {
      throw new GitProviderError("invalid-response");
    }
  }

  private api(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    return this.request(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "context-hub",
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      !["github.com", "api.github.com"].includes(target.hostname) ||
      target.port ||
      target.username ||
      target.password
    ) {
      throw new GitProviderError("invalid-response");
    }
    let response: Response;
    try {
      response = await this.outboundFetch(target.toString(), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new GitProviderError("timeout");
      }
      throw new GitProviderError("network");
    }
    if (!response.ok) throw mapStatus(response.status);
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (type !== "application/json" && type !== "application/vnd.github+json") {
      throw new GitProviderError("invalid-response");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new GitProviderError("invalid-response");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitProviderError("invalid-response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitProviderError("invalid-response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new GitProviderError("invalid-response");
    }
  }

  private requiredString(value: Record<string, unknown>, key: string, max: number): string {
    const field = value[key];
    if (typeof field !== "string" || !field || field.length > max) {
      throw new GitProviderError("invalid-response");
    }
    return field;
  }
}
