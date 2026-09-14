import assert from "node:assert/strict";
import test from "node:test";
import { GithubIdentityLookupProvider } from "../src/github-identity-lookup-provider.js";
import { IdentityLookupProviderError } from "../src/identity-lookup-provider.js";

function github(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("GitHub identity lookup resolves current case-insensitive login to stable provider identity", async () => {
  const requests: string[] = [];
  const provider = new GithubIdentityLookupProvider(async (input) => {
    requests.push(String(input));
    return github({ id: 42, login: "Current-Login" });
  });
  assert.deepEqual(await provider.resolveLogin("current-login"), {
    provider: "github",
    providerUserId: "42",
    username: "Current-Login",
  });
  assert.deepEqual(requests, ["https://api.github.com/users/current-login"]);
});

test("GitHub identity lookup returns unavailable for unknown login and rejects stale/reclaimed mismatch", async () => {
  const missing = new GithubIdentityLookupProvider(async () => github({}, 404));
  assert.equal(await missing.resolveLogin("missing"), null);
  const mismatch = new GithubIdentityLookupProvider(async () =>
    github({ id: 7, login: "reclaimed" }),
  );
  await assert.rejects(() => mismatch.resolveLogin("old-name"), IdentityLookupProviderError);
});

test("GitHub identity lookup bounds and redacts provider failures", async () => {
  const oversized = new GithubIdentityLookupProvider(async () =>
    github({ id: 1, login: "known" }, 200, { "content-length": "9000" }),
  );
  await assert.rejects(() => oversized.resolveLogin("known"), IdentityLookupProviderError);
  const failed = new GithubIdentityLookupProvider(async () => {
    throw new Error("provider secret payload");
  });
  await assert.rejects(
    () => failed.resolveLogin("known"),
    (cause: unknown) =>
      cause instanceof IdentityLookupProviderError && !cause.message.includes("secret"),
  );
});
