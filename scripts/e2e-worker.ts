import type { GitProvider, GitRepositoryInspection } from "../apps/api/src/git-provider.js";
import { createApp, type Env } from "../apps/api/src/index.js";

let currentCommit = "0000000000000000000000000000000000000000";
let oauthIdentity: "admin" | "alice" = "admin";

const identities = {
  admin: { id: 1001, login: "acme-admin", name: "Acme Admin" },
  alice: { id: 1002, login: "alice", name: "Alice Developer" },
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

const providerFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://github.com/login/oauth/access_token") {
    return json({ access_token: `local-${oauthIdentity}` });
  }
  if (url === "https://api.github.com/user") return json(identities[oauthIdentity]);
  const login = decodeURIComponent(url.split("/users/")[1] ?? "").toLowerCase();
  if (login === "alice") return json(identities.alice);
  if (login === "acme-admin") return json(identities.admin);
  return json({ message: "Not Found" }, 404);
};

class LocalGitProvider implements GitProvider {
  installationUrl(state: string) {
    return `https://github.test/install?state=${encodeURIComponent(state)}`;
  }
  userAuthorizationUrl(redirectUri: string, state: string, codeChallenge: string) {
    const url = new URL("https://github.test/authorize");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    return url.href;
  }
  private repository(owner: string, repository: string): GitRepositoryInspection {
    const normalizedOwner = owner.toLowerCase();
    const normalizedRepository = repository.toLowerCase();
    return {
      provider: "github",
      providerRepositoryId: `repo-${normalizedOwner}-${normalizedRepository}`,
      owner: normalizedOwner,
      name: normalizedRepository,
      canonicalUrl: `github.com/${normalizedOwner}/${normalizedRepository}`,
      defaultBranch: "main",
      headSha: currentCommit,
    };
  }
  async authorizeAndInspect(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    installationId: string;
    owner: string;
    repository: string;
  }) {
    return { providerUserId: "1001", repository: this.repository(input.owner, input.repository) };
  }
  async inspectInstallation(input: { installationId: string; owner: string; repository: string }) {
    return this.repository(input.owner, input.repository);
  }
}

const app = createApp(providerFetch, { gitProvider: () => new LocalGitProvider() });

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/identity" && request.method === "GET") {
      return Response.json({ runId: (env as Env & { E2E_RUN_ID?: string }).E2E_RUN_ID ?? null });
    }
    if (url.pathname === "/__e2e/control" && request.method === "POST") {
      const body = (await request.json()) as { commit?: string; identity?: "admin" | "alice" };
      if (body.commit && /^[0-9a-f]{40}$/.test(body.commit)) currentCommit = body.commit;
      if (body.identity === "admin" || body.identity === "alice") oauthIdentity = body.identity;
      return json({ ok: true });
    }
    return app.fetch(request, {
      ...env,
      GITHUB_CLIENT_ID: "local-client",
      GITHUB_CLIENT_SECRET: "local-secret",
      GITHUB_APP_ID: "local-app",
      GITHUB_APP_SLUG: "local-app",
      GITHUB_APP_CLIENT_ID: "local-app-client",
      GITHUB_APP_CLIENT_SECRET: "local-app-secret",
      GITHUB_APP_PRIVATE_KEY: "injected-local-provider-does-not-use-a-key",
    });
  },
};
