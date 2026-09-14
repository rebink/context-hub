import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePagesHeaders } from "../scripts/generate-security-headers.js";
import { normalizeApiOrigin } from "../src/api-origin.js";

function connectSources(headers: string): string[] {
  const match = /(?:^|; )connect-src ([^\n;]+)/.exec(headers);
  assert.ok(match?.[1]);
  return match[1].split(" ");
}

describe("Pages security headers", () => {
  it("generates CSP from the exact normalized API origin used by the browser", () => {
    const configured = "https://API.Context-Hub.test:8443/";
    const normalized = normalizeApiOrigin(configured);
    const value = generatePagesHeaders({ apiUrl: configured, pagesDeployment: true });

    assert.deepEqual(connectSources(value), ["'self'", normalized]);
    assert.equal(normalized, "https://api.context-hub.test:8443");
    assert.match(value, /Content-Security-Policy: default-src 'self'/);
    assert.match(value, /script-src 'self'/);
    assert.match(value, /frame-ancestors 'none'/);
    assert.match(value, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
    assert.match(value, /X-Content-Type-Options: nosniff/);
    assert.match(value, /X-Frame-Options: DENY/);
    assert.match(value, /Referrer-Policy: no-referrer/);
    assert.match(value, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)/);
  });

  it("allows self-only local builds and rejects unsafe Pages API origins", () => {
    assert.deepEqual(connectSources(generatePagesHeaders({ apiUrl: "", pagesDeployment: false })), [
      "'self'",
    ]);
    assert.equal(normalizeApiOrigin("http://localhost:8787"), "http://localhost:8787");

    const rejected = [
      "",
      "https://replace-me.workers.dev",
      "http://api.context-hub.test",
      "https://user:password@api.context-hub.test",
      "https://api.context-hub.test/path",
      "https://api.context-hub.test?query=1",
      "https://api.context-hub.test#fragment",
      "not-an-origin",
      " https://api.context-hub.test",
    ];
    for (const apiUrl of rejected) {
      assert.throws(
        () => generatePagesHeaders({ apiUrl, pagesDeployment: true }),
        /PAGES_API_ORIGIN_REQUIRED|INVALID_API_ORIGIN/,
        apiUrl,
      );
    }
  });
});
