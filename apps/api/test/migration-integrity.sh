#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
WRANGLER="$ROOT/node_modules/.bin/wrangler"
SOURCE_CONFIG="$ROOT/apps/api/wrangler.toml"
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/context-hub-migrations.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT

fresh="$TEMP/fresh"
upgrade="$TEMP/upgrade"
upgrade_project="$TEMP/upgrade-project"
mkdir -p "$fresh" "$upgrade" "$upgrade_project/migrations"

"$WRANGLER" d1 migrations apply DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" >/dev/null

cat >"$TEMP/seed.sql" <<'SQL'
PRAGMA foreign_keys = ON;
INSERT INTO users (id, provider, provider_user_id, username) VALUES ('u','github','1','u');
INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('s','u','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2099-01-01T00:00:00.000Z');
INSERT INTO workspaces (id,name,slug,created_by) VALUES ('w','W','w','u');
INSERT INTO projects (id,workspace_id,name,slug,created_by) VALUES ('p','w','P','p','u');
INSERT INTO repository_identities (id,provider,canonical_url,owner,repository_name) VALUES ('r1','github','github.com/o/one','o','one'),('r2','github','github.com/o/two','o','two');
INSERT INTO git_connections (connection_id,project_id,repository_identity_id,provider,installation_id,provider_repository_id,default_branch,last_known_commit_sha,status,verified_at) VALUES ('c','p','r1','github','1','1','main','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','VERIFIED','2026-01-01T00:00:00.000Z');
INSERT INTO project_repositories (project_id,repository_identity_id) VALUES ('p','r1');
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/seed.sql" >/dev/null

cat >"$TEMP/graphs.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('g1','p',1,'github','1','o','one','github.com/o/one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',1,1,'11111111111111111111111111111111','projects/p/graphs/v/1/attempts/1/11111111111111111111111111111111/graph.json','BUILDING','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2099-01-02','runner','2026-01-01T00:01:00.000Z');
UPDATE graph_build_attempts SET status='FAILED',failure_category='TOOL_FAILED',failed_at='2026-01-01T00:02:00.000Z',orphan_observed_at='2026-01-01T00:02:00.000Z',cleanup_not_before='2099-01-02' WHERE project_id='p' AND graph_version=1 AND attempt=1;
UPDATE graph_versions SET status='QUEUED',attempt=2,failure_category=NULL,failed_at=NULL,build_started_at=NULL,updated_at='2026-01-01T00:03:00.000Z' WHERE id='g1';
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',1,2,'22222222222222222222222222222222','projects/p/graphs/v/1/attempts/2/22222222222222222222222222222222/graph.json','BUILDING','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','2099-01-02','runner','2026-01-01T00:04:00.000Z');
UPDATE graph_build_attempts SET checksum='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',byte_size=100,content_type='application/json',node_count=1,link_count=0,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=1 AND attempt=2;
UPDATE graph_build_attempts SET status='PUBLISHED',published_at='2026-01-01T00:05:00.000Z' WHERE project_id='p' AND graph_version=1 AND attempt=2;
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('g2','p',2,'github','1','o','one','github.com/o/one','cccccccccccccccccccccccccccccccccccccccc','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:06:00.000Z','2026-01-01T00:06:00.000Z');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',2,1,'33333333333333333333333333333333','projects/p/graphs/v/2/attempts/1/33333333333333333333333333333333/graph.json','BUILDING','cccccccccccccccccccccccccccccccc','2099-01-02','runner','2026-01-01T00:07:00.000Z');
UPDATE graph_build_attempts SET checksum='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',byte_size=100,content_type='application/json',node_count=1,link_count=0,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=2 AND attempt=1;
UPDATE graph_build_attempts SET status='PUBLISHED',published_at='2026-01-01T00:08:00.000Z' WHERE project_id='p' AND graph_version=2 AND attempt=1;
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/graphs.sql" >/dev/null

if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' WHERE id='g2'" >/dev/null 2>&1; then
  echo "expected READY immutability failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_events SET failure_category='TAMPERED' WHERE project_id='p'" >/dev/null 2>&1; then
  echo "expected graph event update immutability failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "DELETE FROM graph_events WHERE project_id='p'" >/dev/null 2>&1; then
  echo "expected graph event delete immutability failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_versions (id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) SELECT 'duplicate','p',3,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,'QUEUED',1,queued_at,updated_at FROM graph_versions WHERE id='g2'" >/dev/null 2>&1; then
  echo "expected complete graph identity uniqueness failure" >&2
  exit 1
fi
graph_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS ready_rows FROM graph_versions WHERE project_id='p' AND status='READY'; SELECT COUNT(*) AS superseded_rows FROM graph_versions WHERE id='g1' AND status='SUPERSEDED'; SELECT COUNT(*) AS graph_events FROM graph_events WHERE project_id='p';")
grep -Eq '"ready_rows": 1' <<<"$graph_check"
grep -Eq '"superseded_rows": 1' <<<"$graph_check"
grep -Eq '"graph_events": 10' <<<"$graph_check"

# Invalid status/payload combinations and illegal transitions must fail closed.
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_versions (id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,storage_key,queued_at,updated_at) VALUES ('invalid-payload','p',9,'github','1','o','one','github.com/o/one','9999999999999999999999999999999999999999','0.9.58','1.0.0','code-only-clustered-v1',1,'generator','QUEUED',1,'unexpected','2026-01-01','2026-01-01')" >/dev/null 2>&1; then
  echo "expected graph status/payload check failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='FAILED',failure_category='BAD',failed_at='2026-01-01',updated_at='2026-01-01' WHERE id='g2'" >/dev/null 2>&1; then
  echo "expected illegal graph transition failure" >&2
  exit 1
fi

cat >"$TEMP/out-of-order.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES
('g3','p',3,'github','1','o','one','github.com/o/one','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:09:00.000Z','2026-01-01T00:09:00.000Z'),
('g4','p',4,'github','1','o','one','github.com/o/one','ffffffffffffffffffffffffffffffffffffffff','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:09:00.000Z','2026-01-01T00:09:00.000Z');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at) VALUES
('p',3,1,'44444444444444444444444444444444','projects/p/graphs/v/3/attempts/1/44444444444444444444444444444444/graph.json','BUILDING','dddddddddddddddddddddddddddddddd','2099-01-02','runner','2026-01-01'),
('p',4,1,'55555555555555555555555555555555','projects/p/graphs/v/4/attempts/1/55555555555555555555555555555555/graph.json','BUILDING','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','2099-01-02','runner','2026-01-01');
UPDATE graph_build_attempts SET checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',byte_size=100,content_type='application/json',node_count=1,link_count=0,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=3;
UPDATE graph_build_attempts SET checksum='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',byte_size=100,content_type='application/json',node_count=1,link_count=0,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=4;
UPDATE graph_build_attempts SET status='PUBLISHED',published_at='2026-01-01T00:10:00.000Z' WHERE project_id='p' AND graph_version=4;
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/out-of-order.sql" >/dev/null
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET status='PUBLISHED',published_at='2026-01-01T00:11:00.000Z' WHERE project_id='p' AND graph_version=3" >/dev/null 2>&1; then
  echo "expected stale lower publication rejection" >&2
  exit 1
fi
stale_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS current_v4 FROM graph_versions WHERE id='g4' AND status='READY'; SELECT COUNT(*) AS stale_v3 FROM graph_versions WHERE id='g3' AND status='BUILDING'; SELECT COUNT(*) AS one_ready FROM graph_versions WHERE project_id='p' AND status='READY';")
grep -Eq '"current_v4": 1' <<<"$stale_check"
grep -Eq '"stale_v3": 1' <<<"$stale_check"
grep -Eq '"one_ready": 1' <<<"$stale_check"
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) VALUES('constraint-ready','p',99,'github','1','o','one','github.com/o/one','1414141414141414141414141414141414141414','0.9.58','1.0.0','p',1,'g','QUEUED',1,'2026-01-01','2026-01-01'); INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at) VALUES('p',99,1,'99999999999999999999999999999999','projects/p/graphs/v/99/attempts/1/99999999999999999999999999999999/graph.json','BUILDING','99999999999999999999999999999999','2099-01-01','runner','2026-01-01');" >/dev/null
for invalid_ready in \
  "checksum='NOT-A-SHA',byte_size=100,node_count=1,link_count=0" \
  "checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',byte_size=-1,node_count=1,link_count=0" \
  "checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',byte_size=100,node_count=50001,link_count=0" \
  "checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',byte_size=100,node_count=1,link_count=100001" \
  "checksum='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',byte_size=100,node_count=1,link_count=NULL"; do
  if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='READY',lease_id=NULL,lease_expires_at=NULL,storage_layout='LEGACY_V1',storage_key='projects/p/graphs/v/99/graph.json',$invalid_ready,hyperedge_count=0,generated_by='runner',published_attempt=1,published_lease_id='99999999999999999999999999999999',generated_at='2026-01-01T00:11:00.000Z',updated_at='2026-01-01T00:11:00.000Z' WHERE id='constraint-ready'" >/dev/null 2>&1; then
    echo "expected malformed READY payload rejection: $invalid_ready" >&2
    exit 1
  fi
done

cat >"$TEMP/attempt-v2.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('g5','p',5,'github','1','o','one','github.com/o/one','1111111111111111111111111111111111111111','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:12:00.000Z','2026-01-01T00:12:00.000Z');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',5,1,'pppppppppppppppppppppppppppppppp','projects/p/graphs/v/5/attempts/1/pppppppppppppppppppppppppppppppp/graph.json','BUILDING','66666666666666666666666666666666','2099-01-02','runner','2026-01-01T00:13:00.000Z');
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/attempt-v2.sql" >/dev/null
attempt_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS building_v5 FROM graph_versions WHERE id='g5' AND status='BUILDING'; SELECT COUNT(*) AS attempt_rows FROM graph_build_attempts WHERE project_id='p' AND graph_version=5;")
grep -Eq '"building_v5": 1' <<<"$attempt_check"
grep -Eq '"attempt_rows": 1' <<<"$attempt_check"
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET publication_id='qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' WHERE project_id='p' AND graph_version=5" >/dev/null 2>&1; then
  echo "expected attempt identity immutability failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "DELETE FROM graph_build_attempts WHERE project_id='p' AND graph_version=5" >/dev/null 2>&1; then
  echo "expected attempt delete immutability failure" >&2
  exit 1
fi
if ! "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET checksum='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',byte_size=100,content_type='application/json',node_count=1,link_count=0,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=5" >/dev/null 2>&1; then
  echo "expected claim-bound publication evidence update" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET status='PUBLISHED',generated_by='forged-runner',published_at='2026-01-01T00:13:30.000Z' WHERE project_id='p' AND graph_version=5" >/dev/null 2>&1; then
  echo "expected publisher provenance mismatch failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET status='FAILED',failure_category='TOOL_FAILED',failed_at='2026-01-01T00:14:00.000Z',orphan_observed_at='2026-01-01T00:14:00.000Z',cleanup_not_before='2099-01-02' WHERE project_id='p' AND graph_version=5" >/dev/null; then :; else
  echo "expected valid failed attempt transition" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET failure_category='CHANGED' WHERE project_id='p' AND graph_version=5" >/dev/null 2>&1; then
  echo "expected FAILED attempt outcome immutability failure" >&2
  exit 1
fi

# A same-logical-build retry is legal only after its exact prior attempt failed.
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='QUEUED',attempt=2,failure_category=NULL,failed_at=NULL,build_started_at=NULL,updated_at='2026-01-01T00:15:00.000Z' WHERE id='g5'" >/dev/null

# Legacy layout is migration-only; new rows cannot opt out of attempt evidence.
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,storage_layout,queued_at,updated_at) VALUES('legacy-bypass','p',6,'github','1','o','one','github.com/o/one','1616161616161616161616161616161616161616','0.9.58','1.0.0','p',1,'g','QUEUED',1,'LEGACY_V1','2026-01-01','2026-01-01')" >/dev/null 2>&1; then
  echo "expected new LEGACY_V1 graph rejection" >&2
  exit 1
fi

# Attempt rows must enter through the BUILDING claim shape for the exact queued identity.
for invalid_attempt in \
  "VALUES('p',5,2,'ffffffffffffffffffffffffffffffff','projects/p/graphs/v/5/attempts/2/ffffffffffffffffffffffffffffffff/graph.json','FAILED','77777777777777777777777777777777','2099-01-03','runner','2026-01-01','TOOL_FAILED','2026-01-01',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01','2099-01-02',NULL,NULL,NULL,NULL)" \
  "VALUES('p',5,2,'gggggggggggggggggggggggggggggggg','projects/p/graphs/v/5/attempts/2/gggggggggggggggggggggggggggggggg/graph.json','PUBLISHED','77777777777777777777777777777777','2099-01-03','runner','2026-01-01',NULL,NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'application/json',1,0,0,'runner','2026-01-01',NULL,NULL,NULL,NULL,NULL,NULL)" \
  "VALUES('p',5,2,'hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh','projects/p/graphs/v/5/attempts/2/hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh/graph.json','CLEANED','77777777777777777777777777777777','2099-01-03','runner','2026-01-01','TOOL_FAILED','2026-01-01','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'application/json',1,0,0,'runner',NULL,'2026-01-01','2099-01-02','88888888888888888888888888888888','2099-01-03','2099-01-02','DELETED')" \
  "VALUES('p',5,3,'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii','projects/p/graphs/v/5/attempts/3/iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii/graph.json','BUILDING','77777777777777777777777777777777','2099-01-03','runner','2026-01-01',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)"; do
  if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at,failure_category,failed_at,checksum,byte_size,content_type,node_count,link_count,hyperedge_count,generated_by,published_at,orphan_observed_at,cleanup_not_before,cleanup_claim_id,cleanup_claim_expires_at,cleaned_at,cleanup_result) $invalid_attempt" >/dev/null 2>&1; then
    echo "expected initial attempt lifecycle/identity rejection: $invalid_attempt" >&2
    exit 1
  fi
done

# Direct ATTEMPT_V2 logical transitions cannot manufacture attempt evidence.
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='BUILDING',lease_id='77777777777777777777777777777777',lease_expires_at='2099-01-03',build_started_at='2026-01-01T00:16:00.000Z',updated_at='2026-01-01T00:16:00.000Z' WHERE id='g5'" >/dev/null 2>&1; then
  echo "expected direct ATTEMPT_V2 BUILDING rejection" >&2
  exit 1
fi
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at) VALUES('p',5,2,'jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj','projects/p/graphs/v/5/attempts/2/jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj/graph.json','BUILDING','77777777777777777777777777777777','2099-01-03','runner','2026-01-01T00:16:00.000Z')" >/dev/null
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='FAILED',lease_id=NULL,lease_expires_at=NULL,failure_category='TOOL_FAILED',failed_at='2026-01-01T00:17:00.000Z',updated_at='2026-01-01T00:17:00.000Z' WHERE id='g5'" >/dev/null 2>&1; then
  echo "expected direct ATTEMPT_V2 FAILED rejection" >&2
  exit 1
fi
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET checksum='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',byte_size=101,content_type='application/json',node_count=2,link_count=1,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=5 AND attempt=2" >/dev/null
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='READY',lease_id=NULL,lease_expires_at=NULL,storage_key='projects/p/graphs/v/5/attempts/2/jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj/graph.json',selected_publication_id='jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj',checksum='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',byte_size=101,node_count=2,link_count=1,hyperedge_count=0,generated_by='runner',published_attempt=2,published_lease_id='77777777777777777777777777777777',generated_at='2026-01-01T00:18:00.000Z',updated_at='2026-01-01T00:18:00.000Z' WHERE id='g5'" >/dev/null 2>&1; then
  echo "expected direct ATTEMPT_V2 READY rejection" >&2
  exit 1
fi
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET status='PUBLISHED',published_at='2026-01-01T00:18:00.000Z' WHERE project_id='p' AND graph_version=5 AND attempt=2" >/dev/null
lifecycle_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS published_v5 FROM graph_versions WHERE id='g5' AND status='READY' AND published_attempt=2; SELECT COUNT(*) AS published_attempt_v5 FROM graph_build_attempts WHERE project_id='p' AND graph_version=5 AND attempt=2 AND status='PUBLISHED';")
grep -Eq '"published_v5": 1' <<<"$lifecycle_check"
grep -Eq '"published_attempt_v5": 1' <<<"$lifecycle_check"

# D1 clock time, not a caller-controlled publication timestamp, fences expiry.
cat >"$TEMP/expired-publication.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('expired-publication','p',6,'github','1','o','one','github.com/o/one','2626262626262626262626262626262626262626','0.9.58','1.0.0','code-only-clustered-v1',1,'generator','QUEUED',1,'2026-01-01','2026-01-01');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',6,1,'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk','projects/p/graphs/v/6/attempts/1/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk/graph.json','BUILDING','88888888888888888888888888888888','2000-01-02','runner','2000-01-01');
UPDATE graph_build_attempts SET checksum='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',byte_size=102,content_type='application/json',node_count=2,link_count=1,hyperedge_count=0,generated_by=claimed_by WHERE project_id='p' AND graph_version=6;
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/expired-publication.sql" >/dev/null
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_build_attempts SET status='PUBLISHED',published_at='1999-01-01' WHERE project_id='p' AND graph_version=6" >/dev/null 2>&1; then
  echo "expected database-time expired publication rejection" >&2
  exit 1
fi
expired_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS prior_ready FROM graph_versions WHERE id='g5' AND status='READY'; SELECT COUNT(*) AS expired_building FROM graph_versions WHERE id='expired-publication' AND status='BUILDING'; SELECT COUNT(*) AS unpublished_attempt FROM graph_build_attempts WHERE project_id='p' AND graph_version=6 AND status='BUILDING';")
grep -Eq '"prior_ready": 1' <<<"$expired_check"
grep -Eq '"expired_building": 1' <<<"$expired_check"
grep -Eq '"unpublished_attempt": 1' <<<"$expired_check"

# Cleanup ownership on a failed old attempt cannot block a distinct-key retry.
cat >"$TEMP/cleanup-retry.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('cleanup-retry','p',7,'github','1','o','one','github.com/o/one','2727272727272727272727272727272727272727','0.9.58','1.0.0','code-only-clustered-v1',1,'generator','QUEUED',1,'2026-01-01','2026-01-01');
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',7,1,'llllllllllllllllllllllllllllllll','projects/p/graphs/v/7/attempts/1/llllllllllllllllllllllllllllllll/graph.json','BUILDING','99999999999999999999999999999999','2099-01-02','runner','2026-01-01');
UPDATE graph_build_attempts SET status='FAILED',failure_category='TOOL_FAILED',failed_at='2026-01-02',orphan_observed_at='2026-01-02',cleanup_not_before='2026-01-02' WHERE project_id='p' AND graph_version=7;
UPDATE graph_build_attempts SET cleanup_claim_id='mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',cleanup_claim_expires_at='2099-01-02' WHERE project_id='p' AND graph_version=7;
UPDATE graph_versions SET status='QUEUED',attempt=2,failure_category=NULL,failed_at=NULL,build_started_at=NULL,updated_at='2026-01-03' WHERE id='cleanup-retry';
INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at)
VALUES('p',7,2,'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn','projects/p/graphs/v/7/attempts/2/nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn/graph.json','BUILDING','oooooooooooooooooooooooooooooooo','2099-01-03','runner','2026-01-03');
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/cleanup-retry.sql" >/dev/null
cleanup_retry_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS old_claim FROM graph_build_attempts WHERE project_id='p' AND graph_version=7 AND attempt=1 AND status='FAILED' AND cleanup_claim_id IS NOT NULL; SELECT COUNT(*) AS new_attempt FROM graph_build_attempts WHERE project_id='p' AND graph_version=7 AND attempt=2 AND status='BUILDING'; SELECT COUNT(DISTINCT storage_key) AS distinct_keys FROM graph_build_attempts WHERE project_id='p' AND graph_version=7;")
grep -Eq '"old_claim": 1' <<<"$cleanup_retry_check"
grep -Eq '"new_attempt": 1' <<<"$cleanup_retry_check"
grep -Eq '"distinct_keys": 2' <<<"$cleanup_retry_check"

# Restored 0007 bounds and exact lifecycle payloads must reject malformed direct SQL.
for invalid_sql in \
  "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) VALUES('bad-sha','p',20,'github','1','o','one','github.com/o/one','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','0.9.58','1.0.0','p',1,'g','QUEUED',1,'2026-01-01','2026-01-01')" \
  "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) VALUES('bad-count','p',21,'github','1','o','one','github.com/o/one','1212121212121212121212121212121212121212','0.9.58','1.0.0','p',1,'g','QUEUED',-1,'2026-01-01','2026-01-01')" \
  "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) VALUES('over-bound','p',2147483648,'github','1','o','one','github.com/o/one','1313131313131313131313131313131313131313','0.9.58','1.0.0','p',1,'g','QUEUED',1,'2026-01-01','2026-01-01')" \
  "INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at) VALUES('p',5,2,'short','bad','BUILDING','short','2099-01-02','runner','2026-01-01')" \
  "INSERT INTO graph_events(project_id,graph_version,from_status,to_status,attempt,failure_category,created_at) VALUES('p',5,'QUEUED','READY',1,NULL,'2026-01-01')" \
  "INSERT INTO graph_events(project_id,graph_version,from_status,to_status,attempt,failure_category,created_at) VALUES('p',5,'BUILDING','FAILED',1,NULL,'2026-01-01')"; do
  if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "$invalid_sql" >/dev/null 2>&1; then
    echo "expected restored graph constraint failure: $invalid_sql" >&2
    exit 1
  fi
done
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "UPDATE graph_versions SET status='QUEUED',attempt=2,failure_category=NULL,failed_at=NULL,build_started_at=NULL,node_count=-1,updated_at='2099-01-02' WHERE id='g5'" >/dev/null 2>&1; then
  echo "expected QUEUED payload/count rejection" >&2
  exit 1
fi

if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO project_repositories (project_id,repository_identity_id) VALUES ('p','r2')" >/dev/null 2>&1; then
  echo "expected one-link uniqueness failure" >&2
  exit 1
fi
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "INSERT INTO project_repositories (project_id,repository_identity_id) VALUES ('missing','r2')" >/dev/null 2>&1; then
  echo "expected foreign-key failure" >&2
  exit 1
fi

cat >"$TEMP/transaction.sql" <<'SQL'
INSERT INTO git_audit_events (id,project_id,repository_identity_id,event_type,actor_id,metadata) VALUES ('rollback-proof','p','r1','git-synced','u','{}');
INSERT INTO project_repositories (project_id,repository_identity_id) VALUES ('p','r2');
SQL
if "$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --file "$TEMP/transaction.sql" >/dev/null 2>&1; then
  echo "expected transactional batch failure" >&2
  exit 1
fi
fresh_check=$("$WRANGLER" d1 execute DB --local --persist-to "$fresh" --config "$SOURCE_CONFIG" --command "SELECT COUNT(*) AS audit_rows FROM git_audit_events WHERE id='rollback-proof'; SELECT COUNT(*) AS hardening_indexes FROM sqlite_master WHERE type='index' AND name IN ('project_repositories_one_per_project_idx','github_connection_states_session_project_idx','git_connections_connection_id_idx');")
grep -Eq '"audit_rows": 0' <<<"$fresh_check"
grep -Eq '"hardening_indexes": 3' <<<"$fresh_check"

cp "$SOURCE_CONFIG" "$upgrade_project/wrangler.toml"
cp "$ROOT"/apps/api/migrations/000[1-4]_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cat >"$TEMP/legacy.sql" <<'SQL'
PRAGMA foreign_keys = ON;
INSERT INTO users (id, provider, provider_user_id, username) VALUES ('u','github','1','u');
INSERT INTO workspaces (id,name,slug,created_by) VALUES ('w','W','w','u');
INSERT INTO projects (id,workspace_id,name,slug,created_by) VALUES
  ('p','w','P','p','u'),
  ('p-missing','w','Missing link','missing','u'),
  ('p-wrong','w','Wrong link','wrong','u');
INSERT INTO repository_identities (id,provider,canonical_url,owner,repository_name) VALUES ('r1','github','github.com/o/one','o','one'),('r2','github','github.com/o/two','o','two');
INSERT INTO project_repositories (project_id,repository_identity_id) VALUES
  ('p','r1'),('p','r2');
INSERT INTO git_connections (project_id,repository_identity_id,provider,installation_id,provider_repository_id,default_branch,last_known_commit_sha,status,verified_at) VALUES
  ('p','r2','github','2','2','main','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','VERIFIED','2026-01-01T00:00:00.000Z'),
  ('p-missing','r1','github','1','1','main','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','VERIFIED','2026-01-01T00:00:00.000Z'),
  ('p-wrong','r1','github','1','1','main','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','VERIFIED','2026-01-01T00:00:00.000Z');
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --file "$TEMP/legacy.sql" >/dev/null
cp "$ROOT"/apps/api/migrations/0005_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
pre_reconciliation=$("$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "SELECT COUNT(*) AS missing_links FROM project_repositories WHERE project_id IN ('p-missing','p-wrong');")
grep -Eq '"missing_links": 0' <<<"$pre_reconciliation"
# Model a post-0005 row with its sole link pointed at a non-authoritative identity.
"$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "INSERT INTO project_repositories (project_id,repository_identity_id) VALUES ('p-wrong','r2');" >/dev/null

cp "$ROOT"/apps/api/migrations/0006_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
upgrade_check=$("$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "SELECT project_id, repository_identity_id FROM project_repositories WHERE project_id IN ('p','p-missing','p-wrong') ORDER BY project_id; SELECT COUNT(*) AS reconciled FROM project_repositories pr JOIN git_connections gc ON gc.project_id=pr.project_id AND gc.repository_identity_id=pr.repository_identity_id WHERE gc.status='VERIFIED'; SELECT COUNT(*) AS applied FROM d1_migrations WHERE name IN ('0005_git_connection_hardening.sql','0006_git_connection_link_reconciliation.sql');")
grep -Eq '"project_id": "p-missing"' <<<"$upgrade_check"
grep -Eq '"project_id": "p-wrong"' <<<"$upgrade_check"
[[ $(grep -c '"repository_identity_id": "r1"' <<<"$upgrade_check") -eq 2 ]]
grep -Eq '"reconciled": 3' <<<"$upgrade_check"
grep -Eq '"applied": 2' <<<"$upgrade_check"

cp "$ROOT"/apps/api/migrations/0007_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cp "$ROOT"/apps/api/migrations/0008_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cp "$ROOT"/apps/api/migrations/0009_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
upgrade_graph_check=$("$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "SELECT COUNT(*) AS graph_tables FROM sqlite_master WHERE type='table' AND name IN ('graph_versions','graph_events'); SELECT COUNT(*) AS graph_event_immutability_triggers FROM sqlite_master WHERE type='trigger' AND name IN ('graph_events_immutable_update','graph_events_immutable_delete'); SELECT COUNT(*) AS orphan_columns FROM pragma_table_info('graph_versions') WHERE name IN ('orphan_observed_at','orphan_attempt','orphan_lease_id','orphan_checksum','orphan_byte_size','orphan_cleanup_id','orphan_cleanup_expires_at'); SELECT COUNT(*) AS applied FROM d1_migrations WHERE name IN ('0005_git_connection_hardening.sql','0006_git_connection_link_reconciliation.sql','0007_graph_versions.sql','0008_graph_event_delete_immutability.sql','0009_graph_orphan_reconciliation.sql');")
grep -Eq '"graph_tables": 2' <<<"$upgrade_graph_check"
grep -Eq '"graph_event_immutability_triggers": 2' <<<"$upgrade_graph_check"
grep -Eq '"orphan_columns": 7' <<<"$upgrade_graph_check"
grep -Eq '"applied": 5' <<<"$upgrade_graph_check"

# Seed a published legacy row before applying 0010, then prove the staged upgrade preserves it.
cat >"$TEMP/legacy-graphs.sql" <<'SQL'
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('g1','p',1,'github','1','o','one','github.com/o/one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
UPDATE graph_versions SET status='BUILDING',lease_id='11111111111111111111111111111111',lease_expires_at='2099-01-02',build_started_at='2026-01-01T00:01:00.000Z',updated_at='2026-01-01T00:01:00.000Z' WHERE id='g1';
UPDATE graph_versions SET status='FAILED',lease_id=NULL,lease_expires_at=NULL,failure_category='TOOL_FAILED',failed_at='2026-01-01T00:02:00.000Z',updated_at='2026-01-01T00:02:00.000Z' WHERE id='g1';
UPDATE graph_versions SET status='QUEUED',attempt=2,failure_category=NULL,failed_at=NULL,build_started_at=NULL,updated_at='2026-01-01T00:03:00.000Z' WHERE id='g1';
UPDATE graph_versions SET status='BUILDING',lease_id='22222222222222222222222222222222',lease_expires_at='2099-01-02',build_started_at='2026-01-01T00:04:00.000Z',updated_at='2026-01-01T00:04:00.000Z' WHERE id='g1';
UPDATE graph_versions SET status='READY',lease_id=NULL,lease_expires_at=NULL,storage_key='projects/p/graphs/v/1/graph.json',checksum='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',byte_size=100,node_count=1,link_count=0,hyperedge_count=0,generated_by='runner',published_attempt=2,published_lease_id='22222222222222222222222222222222',generated_at='2026-01-01T00:05:00.000Z',updated_at='2026-01-01T00:05:00.000Z' WHERE id='g1';
INSERT INTO graph_versions
(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at)
VALUES ('g2','p',2,'github','1','o','one','github.com/o/one','cccccccccccccccccccccccccccccccccccccccc','0.9.58','1.0.0','code-only-clustered-v1',1,'graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1','QUEUED',1,'2026-01-01T00:06:00.000Z','2026-01-01T00:06:00.000Z');
UPDATE graph_versions SET status='BUILDING',lease_id='33333333333333333333333333333333',lease_expires_at='2099-01-02',build_started_at='2026-01-01T00:07:00.000Z',updated_at='2026-01-01T00:07:00.000Z' WHERE id='g2';
UPDATE graph_versions SET status='READY',lease_id=NULL,lease_expires_at=NULL,storage_key='projects/p/graphs/v/2/graph.json',checksum='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',byte_size=100,node_count=1,link_count=0,hyperedge_count=0,generated_by='runner',published_attempt=1,published_lease_id='33333333333333333333333333333333',generated_at='2026-01-01T00:08:00.000Z',updated_at='2026-01-01T00:08:00.000Z' WHERE id='g2';
SQL
"$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --file "$TEMP/legacy-graphs.sql" >/dev/null
"$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,queued_at,updated_at) VALUES('legacy-building','p',3,'github','1','o','one','github.com/o/one','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','0.9.58','1.0.0','code-only-clustered-v1',1,'generator','QUEUED',1,'2026-01-01','2026-01-01'); UPDATE graph_versions SET status='BUILDING',lease_id='77777777777777777777777777777777',lease_expires_at='2099-01-01',build_started_at='2026-01-01',updated_at='2026-01-01' WHERE id='legacy-building';" >/dev/null
cp "$ROOT"/apps/api/migrations/0010_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cp "$ROOT"/apps/api/migrations/0011_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cp "$ROOT"/apps/api/migrations/0012_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
cp "$ROOT"/apps/api/migrations/0013_*.sql "$upgrade_project/migrations/"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" >/dev/null
v2_upgrade_check=$("$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "SELECT COUNT(*) AS legacy_rows FROM graph_versions WHERE status IN ('READY','SUPERSEDED') AND storage_layout='LEGACY_V1' AND selected_publication_id IS NULL; SELECT COUNT(*) AS attempt_table FROM sqlite_master WHERE type='table' AND name='graph_build_attempts'; SELECT COUNT(*) AS retry_rows FROM graph_versions WHERE id='legacy-building' AND status='FAILED' AND failure_category='MIGRATION_RETRY' AND storage_layout='ATTEMPT_V2'; SELECT COUNT(*) AS retry_events FROM graph_events WHERE project_id='p' AND graph_version=3 AND from_status='BUILDING' AND to_status='FAILED' AND attempt=1 AND failure_category='MIGRATION_RETRY' AND created_at='2026-01-01'; SELECT COUNT(*) AS applied FROM d1_migrations WHERE name IN ('0010_attempt_scoped_graph_payloads.sql','0011_graph_constraint_restoration.sql','0012_graph_lifecycle_evidence_guards.sql','0013_graph_lease_cleanup_hardening.sql');")
grep -Eq '"legacy_rows": 2' <<<"$v2_upgrade_check"
grep -Eq '"attempt_table": 1' <<<"$v2_upgrade_check"
grep -Eq '"retry_rows": 1' <<<"$v2_upgrade_check"
grep -Eq '"retry_events": 1' <<<"$v2_upgrade_check"
grep -Eq '"applied": 4' <<<"$v2_upgrade_check"
"$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "UPDATE graph_versions SET status='QUEUED',attempt=attempt+1,failure_category=NULL,failed_at=NULL,build_started_at=NULL,updated_at='2099-01-02' WHERE id='legacy-building'" >/dev/null
migration_retry_check=$("$WRANGLER" d1 execute DB --local --persist-to "$upgrade" --config "$upgrade_project/wrangler.toml" --command "SELECT COUNT(*) AS queued_retry FROM graph_versions WHERE id='legacy-building' AND status='QUEUED' AND attempt=2")
grep -Eq '"queued_retry": 1' <<<"$migration_retry_check"

echo "fresh and staged-through-0013 upgrade migrations, exact graph lifecycle evidence, restored graph bounds/status/provenance constraints, migration-event consistency, attempt/event immutability, reconciliation, uniqueness, foreign keys, and transactional rollback passed"
