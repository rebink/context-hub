# ADR 0002: GitHub App repository credentials

- Status: Accepted
- Date: 2026-03-10

## Context

Context Hub's existing GitHub OAuth is an identity-only login. It intentionally requests no repository scope and discards its access token after `/user`. Repository inspection needs a separate, least-privilege credential boundary without putting reusable provider credentials in the browser or D1.

## Decision

Keep identity OAuth unchanged. Repository connections use a separate GitHub App installation flow with Metadata read and Contents read permissions. The Worker stores the App client secret and private key as secret bindings. D1 stores only the App installation ID/reference, repository identity and inspection metadata, and hashes of short-lived one-time connection state and PKCE verifier.

The installation callback is followed by GitHub App user authorization with PKCE. Context Hub verifies that the transient GitHub user matches the authenticated identity and proves access to the specific installation through `/user/installations/{installation_id}/repositories`; it does not depend on finding the installation in a bounded page of all installations. It then signs a short-lived RS256 App JWT in memory, mints an installation token restricted to the selected repository, inspects that exact repository, and discards all transient tokens and the JWT. One repository is connected per project for the MVP, while the same canonical repository may be linked to multiple projects.

`GitProvider` owns fixed GitHub endpoints, authorization URL construction, PKCE exchange, identity and installation proof, App JWT signing, exact-repository installation-token issuance, bounded provider responses, and validated repository inspection. Domain code owns sessions, project ADMIN authorization, one-time state, D1 publication, repository normalization, audit, and API errors. Connection state is bound to the exact hashed-token-backed application session, remains as consumed metadata only while provider calls finish, and is rechecked during atomic publication. Successful publication and disconnect invalidate all project sibling flows. Sync and disconnect predicate mutations and audit on the exact loaded connection ID and provider tuple so a replacement wins with a bounded stale-operation conflict.

## Operations and recovery

### Secret rotation

Rotate the GitHub App client secret and private key independently. Add the replacement secret/key to the Worker secret store, deploy a Worker that can use it, run a non-production installation and sync check, and only then revoke the old material in GitHub. Private-key rotation is forward-only: retain the old key only for the overlap needed to verify the new deployment, never place either key in source, D1, logs, or support artifacts, and redeploy immediately after revocation. A suspected compromise skips overlap: revoke first, replace the binding, deploy, and treat provider calls during the interval as unavailable. Identity OAuth credentials are a separate rotation boundary.

### Installation revocation and failed connections

GitHub App uninstall, suspension, installation-token revocation, or permission removal must not fall back to another credential. Provider failures remain bounded and redacted; the last verified metadata may remain for diagnosis, but operators must disable resolution by changing the affected connection from `VERIFIED` to `ERROR` until a project ADMIN reconnects and verification succeeds. Prefer the authenticated disconnect route when the ADMIN and provider flow are available because it atomically removes the active link/reference and records the actor. Emergency operational disablement must be project- and connection-ID-specific, preserve the canonical repository identity, and be accompanied by a separately retained incident/change record until generalized operational audit exists.

Expired, consumed, abandoned, or failed `github_connection_states` contain no plaintext secret and may be deleted after confirming that no callback publication is in progress. Routine cleanup deletes rows at or before `expires_at`; incident cleanup may delete all states for the exact project to invalidate sibling flows. Never revive or edit a consumed state. Recovery starts a new installation/authorization flow.

### Disconnect and disable recovery

A successful disconnect removes the unique project link, connection row, and sibling flow states in one D1 batch while preserving repository identity and audit provenance. If it returns stale or forbidden, reload membership and connection state rather than retrying the old tuple. To recover an accidental disconnect, run the normal App flow again; do not reconstruct a connection row or copy an installation reference between projects. For a connection disabled as `ERROR`, either restore it only through a successful exact-repository verification or disconnect and reconnect it; do not mark it `VERIFIED` manually.

### Migration recovery

Before applying a Git migration remotely, capture the D1 backup/export required by the environment and test both fresh and ordered upgrade paths. Migrations are additive and are never edited or rolled back in place. On migration failure, stop application rollout, retain the failed database and migration output with secrets removed, restore the pre-migration backup to a separate recovery database when necessary, fix the forward migration, and re-run integrity checks before rebinding traffic. If schema application succeeded but application deployment failed, keep the compatible additive schema and roll the Worker forward or back only to a version known to tolerate it.

### Route and provider rollback

Provider and callback rollout uses a canary/non-production App first. A bad frontend can be rolled back independently because callback query values are only untrusted completion notices and project-scoped GET is authoritative. A bad Worker route may be rolled back only to a schema-compatible build; otherwise disable the connect/sync route at the edge or revoke/suspend the App while keeping authenticated status reads and disconnect available where safe. Do not change callback origins, bypass state/session checks, broaden installation permissions, or retain provider tokens as a rollback shortcut. Forward recovery is preferred: correct the adapter or route, deploy, verify one exact repository, then re-enable new flows.

### Incident handling and redaction

Incident records may contain project ID, connection ID, installation ID, canonical repository identity, bounded timestamps, provider status class, and redacted request correlation data. They must not contain callback codes, OAuth or installation tokens, App JWTs, PKCE verifier/cookies, session cookies or hashes, client secrets, private keys, authorization headers, provider response bodies, repository contents, or artifact contents. Sanitize URLs by removing query strings before sharing. Revoke exposed material, invalidate exact project states, disable affected verified links, preserve D1/audit evidence, and document the forward-recovery verification without copying secrets into tickets or chat.

## Rejected alternatives

- Personal access tokens: long-lived, user-managed, and too easy to over-scope or leak.
- Repository-scoped identity OAuth or persisted OAuth user tokens: mixes login and repository authority and retains user credentials.
- Persisted App JWTs or installation tokens: unnecessary because both can be minted just in time and are short lived.
- Provider factories, registries, or speculative providers: no second provider exists.

## Consequences

D1 never contains a PAT, user access token, App JWT, installation token, private key, App client secret, or plaintext application session token. Disconnect removes the active project credential reference/link but preserves canonical repository identity and audit provenance. Repository resolution requires a verified connection consistent with the unique project link. Callback construction requires an exact origin-only `API_ORIGIN`; production requires HTTPS, while explicitly configured HTTP remains available outside production for local development. Live GitHub App setup, callback configuration, key formatting, installation revocation, and platform rate behavior remain deployment verification gates.
