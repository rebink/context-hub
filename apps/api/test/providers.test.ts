/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models the Cloudflare R2 binding structurally. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { AuthProviderResponseError } from "../src/auth-provider.js";
import { GitProviderError } from "../src/git-provider.js";
import { GithubAuthProvider } from "../src/github-auth-provider.js";
import { GithubGitProvider } from "../src/github-git-provider.js";
import { R2ObjectStorage } from "../src/r2-object-storage.js";

describe("GitHub AuthProvider contract", () => {
  it("builds the exact authorization URL and exchanges a code without returning the token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const outbound: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return Response.json({ access_token: "transient-secret" });
      return Response.json({
        id: 42,
        login: "octocat",
        name: "Octo Cat",
        avatar_url: "https://avatars.example/42",
      });
    };
    const provider = new GithubAuthProvider(
      { clientId: "client-id", clientSecret: "client-secret" },
      outbound,
    );
    const authorization = new URL(
      provider.authorizationUrl("https://api.example/auth/github/callback", "state-value"),
    );
    assert.equal(
      authorization.origin + authorization.pathname,
      "https://github.com/login/oauth/authorize",
    );
    assert.deepEqual(Object.fromEntries(authorization.searchParams), {
      client_id: "client-id",
      redirect_uri: "https://api.example/auth/github/callback",
      state: "state-value",
      scope: "",
    });

    const identity = await provider.exchangeCode("callback-code");
    assert.deepEqual(identity, {
      provider: "github",
      providerUserId: "42",
      username: "octocat",
      displayName: "Octo Cat",
      avatarUrl: "https://avatars.example/42",
    });
    assert.equal(JSON.stringify(identity).includes("transient-secret"), false);
    assert.deepEqual(calls[0], {
      url: "https://github.com/login/oauth/access_token",
      init: {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "client-id",
          client_secret: "client-secret",
          code: "callback-code",
        }),
      },
    });
    assert.deepEqual(calls[1], {
      url: "https://api.github.com/user",
      init: {
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer transient-secret",
          "user-agent": "context-hub",
          "x-github-api-version": "2022-11-28",
        },
      },
    });
  });

  it("maps provider HTTP and required-shape failures while normalizing malformed optional fields", async () => {
    const replies = [
      [new Response(null, { status: 503 })],
      [Response.json({})],
      [Response.json({ access_token: "token" }), new Response(null, { status: 403 })],
      [Response.json({ access_token: "token" }), Response.json({ id: "42", login: "octocat" })],
      [Response.json({ access_token: "token" }), Response.json({ id: 42, login: "" })],
    ];
    for (const responses of replies) {
      const provider = new GithubAuthProvider(
        { clientId: "id", clientSecret: "secret" },
        (async () => responses.shift() ?? Response.json({})) as typeof fetch,
      );
      await assert.rejects(provider.exchangeCode("code"), AuthProviderResponseError);
    }

    const responses = [
      Response.json({ access_token: "token" }),
      Response.json({ id: 42, login: "octocat", name: 7, avatar_url: {} }),
    ];
    const provider = new GithubAuthProvider(
      { clientId: "id", clientSecret: "secret" },
      (async () => responses.shift() ?? Response.json({})) as typeof fetch,
    );
    assert.deepEqual(await provider.exchangeCode("code"), {
      provider: "github",
      providerUserId: "42",
      username: "octocat",
      displayName: null,
      avatarUrl: null,
    });
  });

  it("propagates network and malformed JSON failures", async () => {
    const network = new Error("network failed");
    const failed = new GithubAuthProvider({ clientId: "id", clientSecret: "secret" }, (async () => {
      throw network;
    }) as typeof fetch);
    await assert.rejects(failed.exchangeCode("code"), network);

    const malformed = new GithubAuthProvider(
      { clientId: "id", clientSecret: "secret" },
      (async () =>
        new Response("not json", {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await assert.rejects(malformed.exchangeCode("code"), SyntaxError);
  });
});

async function githubAppPrivateKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const wrapped =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

function gitConfig(privateKey: string) {
  return {
    appId: "1234",
    appSlug: "context-hub-test",
    clientId: "app-client-id",
    clientSecret: "app-client-secret",
    privateKey,
  };
}

describe("GitHub GitProvider contract", () => {
  it("builds fixed installation and PKCE URLs and completes proof without returning tokens", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const replies = [
      { access_token: "user-secret" },
      { id: 42, login: "octocat" },
      { total_count: 250, repositories: [{ id: 7 }] },
      { token: "installation-secret" },
      { id: 7, name: "Repo", full_name: "Owner/Repo", default_branch: "main" },
      { object: { sha: "a".repeat(40) } },
    ];
    const provider = new GithubGitProvider(
      gitConfig(await githubAppPrivateKey()),
      (async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json(replies.shift());
      }) as typeof fetch,
      () => 1_700_000_000_000,
    );
    const installation = new URL(provider.installationUrl("install-state"));
    assert.equal(
      installation.origin + installation.pathname,
      "https://github.com/apps/context-hub-test/installations/new",
    );
    assert.equal(installation.searchParams.get("state"), "install-state");
    const authorization = new URL(
      provider.userAuthorizationUrl(
        "https://api.example/auth/github-app/callback",
        "auth-state",
        "challenge",
      ),
    );
    assert.equal(
      authorization.origin + authorization.pathname,
      "https://github.com/login/oauth/authorize",
    );
    assert.deepEqual(Object.fromEntries(authorization.searchParams), {
      client_id: "app-client-id",
      redirect_uri: "https://api.example/auth/github-app/callback",
      state: "auth-state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });

    const result = await provider.authorizeAndInspect({
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://api.example/auth/github-app/callback",
      installationId: "99",
      owner: "Owner",
      repository: "Repo",
    });
    assert.deepEqual(result, {
      providerUserId: "42",
      repository: {
        provider: "github",
        providerRepositoryId: "7",
        owner: "owner",
        name: "repo",
        canonicalUrl: "github.com/owner/repo",
        defaultBranch: "main",
        headSha: "a".repeat(40),
      },
    });
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.deepEqual(
      calls.map(
        (call) => new URL(call.url).origin + new URL(call.url).pathname + new URL(call.url).search,
      ),
      [
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
        "https://api.github.com/user/installations/99/repositories?per_page=1",
        "https://api.github.com/app/installations/99/access_tokens",
        "https://api.github.com/repos/Owner/Repo",
        "https://api.github.com/repos/Owner/Repo/git/ref/heads/main",
      ],
    );
    assert.ok(calls.every((call) => call.init?.redirect === "error"));
    const appTokenCall = calls[3];
    assert.ok(appTokenCall);
    const authorizationHeader = new Headers(appTokenCall.init?.headers).get("authorization");
    assert.ok(authorizationHeader);
    const jwt = authorizationHeader.slice(7);
    const encodedClaims = jwt.split(".")[1];
    assert.ok(encodedClaims);
    const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString());
    assert.deepEqual(claims, { iat: 1699999940, exp: 1700000480, iss: "1234" });
    assert.deepEqual(JSON.parse(String(appTokenCall.init?.body)), {
      repositories: ["Repo"],
      permissions: { metadata: "read", contents: "read" },
    });
  });

  it("proves the specific user installation without paginating all installations and validates repository identity, branch, and SHA", async () => {
    const privateKey = await githubAppPrivateKey();
    const mismatchReplies = [
      { access_token: "token" },
      { id: 1, login: "u" },
      { total_count: "invalid", repositories: [] },
    ];
    const mismatch = new GithubGitProvider(gitConfig(privateKey), (async () =>
      Response.json(mismatchReplies.shift())) as typeof fetch);
    await assert.rejects(
      mismatch.authorizeAndInspect({
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://api.example/c",
        installationId: "9",
        owner: "o",
        repository: "r",
      }),
      (error: unknown) => error instanceof GitProviderError && error.kind === "invalid-response",
    );

    for (const repositoryReply of [
      { id: 7, name: "other", full_name: "o/other", default_branch: "main" },
      { id: 7, name: "r", full_name: "o/r", default_branch: "bad..branch" },
    ]) {
      const replies = [{ token: "token" }, repositoryReply, { object: { sha: "z".repeat(40) } }];
      const provider = new GithubGitProvider(gitConfig(privateKey), (async () =>
        Response.json(replies.shift())) as typeof fetch);
      await assert.rejects(
        provider.inspectInstallation({ installationId: "9", owner: "o", repository: "r" }),
        GitProviderError,
      );
    }
  });

  it("accepts the standard PKCS#1 private key emitted for GitHub Apps", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    let authorization: string | null = null;
    const provider = new GithubGitProvider(gitConfig(privateKey), (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    await assert.rejects(
      provider.inspectInstallation({ installationId: "9", owner: "o", repository: "r" }),
      (error: unknown) => error instanceof GitProviderError && error.kind === "unauthorized",
    );
    assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it("maps HTTP, network, and malformed or oversized responses to stable redacted failures", async () => {
    const privateKey = await githubAppPrivateKey();
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [429, "rate-limited"],
      [500, "unavailable"],
    ] as const) {
      const provider = new GithubGitProvider(
        gitConfig(privateKey),
        (async () =>
          new Response("{}", {
            status,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      );
      await assert.rejects(
        provider.authorizeAndInspect({
          code: "secret-code",
          codeVerifier: "secret-verifier",
          redirectUri: "https://api.example/c",
          installationId: "9",
          owner: "o",
          repository: "r",
        }),
        (error: unknown) =>
          error instanceof GitProviderError &&
          error.kind === kind &&
          !error.message.includes("secret"),
      );
    }
    const network = new GithubGitProvider(gitConfig(privateKey), (async () => {
      throw new Error("token leaked");
    }) as typeof fetch);
    await assert.rejects(
      network.authorizeAndInspect({
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://api.example/c",
        installationId: "9",
        owner: "o",
        repository: "r",
      }),
      (error: unknown) =>
        error instanceof GitProviderError &&
        error.kind === "network" &&
        !error.message.includes("leaked"),
    );
    const oversized = new GithubGitProvider(
      gitConfig(privateKey),
      (async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "999999" },
        })) as typeof fetch,
    );
    await assert.rejects(
      oversized.authorizeAndInspect({
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://api.example/c",
        installationId: "9",
        owner: "o",
        repository: "r",
      }),
      (error: unknown) => error instanceof GitProviderError && error.kind === "invalid-response",
    );
  });
});

class FakeR2 {
  objects = new Map<string, { bytes: Uint8Array; httpMetadata: any; customMetadata: any }>();
  calls: Array<{ operation: string; key: string; options?: any }> = [];
  failure?: string;

  async put(key: string, value: Uint8Array, options: any) {
    this.calls.push({ operation: "put", key, options });
    if (this.failure === "put") throw new Error("put failed");
    if (this.objects.has(key)) return null;
    this.objects.set(key, {
      bytes: value.slice(),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    return { key };
  }
  async head(key: string) {
    this.calls.push({ operation: "head", key });
    if (this.failure === "head") throw new Error("head failed");
    const object = this.objects.get(key);
    return object
      ? {
          size: object.bytes.byteLength,
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        }
      : null;
  }
  async get(key: string) {
    this.calls.push({ operation: "get", key });
    if (this.failure === "get") throw new Error("get failed");
    const object = this.objects.get(key);
    return object ? { arrayBuffer: async () => object.bytes.slice().buffer } : null;
  }
  async delete(key: string) {
    this.calls.push({ operation: "delete", key });
    if (this.failure === "delete") throw new Error("delete failed");
    this.objects.delete(key);
  }
}

describe("R2 ObjectStorage contract", () => {
  it("creates only once with exact metadata, then heads and gets bytes", async () => {
    const r2 = new FakeR2();
    const storage = new R2ObjectStorage(r2 as unknown as R2Bucket);
    const bytes = new TextEncoder().encode("payload");
    const metadata = { contentType: "text/plain", checksum: "sha256", uploadId: "upload" };
    assert.equal(await storage.createOnly("key", bytes, metadata), "created");
    assert.equal(await storage.createOnly("key", bytes, metadata), "collision");
    assert.deepEqual(r2.calls[0], {
      operation: "put",
      key: "key",
      options: {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "text/plain" },
        customMetadata: metadata,
      },
    });
    assert.deepEqual(await storage.head("key"), {
      byteSize: bytes.byteLength,
      httpContentType: metadata.contentType,
      metadata,
    });
    assert.deepEqual(await storage.getBytes("key"), bytes);
    assert.equal(await storage.head("missing"), null);
    assert.equal(await storage.getBytes("missing"), null);
  });

  it("uses the explicitly named compensation delete and propagates every R2 failure", async () => {
    const r2 = new FakeR2();
    const storage = new R2ObjectStorage(r2 as unknown as R2Bucket);
    const metadata = { contentType: "text/plain", checksum: "sha256", uploadId: "upload" };
    for (const [failure, operation] of [
      ["put", () => storage.createOnly("key", new Uint8Array(), metadata)],
      ["head", () => storage.head("key")],
      ["get", () => storage.getBytes("key")],
      ["delete", () => storage.compensationDelete("key")],
    ] as const) {
      r2.failure = failure;
      await assert.rejects(operation(), new RegExp(`${failure} failed`));
    }
    r2.failure = undefined;
    await storage.compensationDelete("key");
    assert.deepEqual(r2.calls.at(-1), { operation: "delete", key: "key" });
  });
});
