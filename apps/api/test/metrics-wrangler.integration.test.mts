import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const CONFIG = path.join(ROOT, "apps/api/wrangler.toml");

type MetricsResponse = {
  reliability: { graphBuild: unknown; snapshots: unknown };
  timing: {
    graphDurationMs: { sampleCount: number; average: number; minimum: number; maximum: number };
  };
  immutableObjectMetadata: {
    artifacts: unknown;
    graphs: unknown;
  };
  coverage: { auditEvents: number; firstEventAt: string; lastEventAt: string };
  activity: { artifactEvents: number };
  onboarding: { projectsCreated: number };
  window: { from: string; to: string };
  [key: string]: unknown;
};

function run(command: string, args: string[], cwd = ROOT) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${output}`)),
    );
  });
}

async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The detached Wrangler process group already exited.
  }
}

function graphVersion(version: number) {
  return `('graph-${version}','project-main',${version},'github','repo-id','owner','repo','https://github.com/owner/repo','${String(version).repeat(40).slice(0, 40)}','1','1','default',1,'fixture','QUEUED',1,'ATTEMPT_V2',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}

function claim(version: number, claimedOffset: string) {
  const publication = `publication-${version}`.padEnd(32, "x");
  const lease = `lease-${version}`.padEnd(32, "x");
  return `INSERT INTO graph_build_attempts(project_id,graph_version,attempt,publication_id,storage_key,status,lease_id,lease_expires_at,claimed_by,claimed_at) VALUES('project-main',${version},1,'${publication}','projects/project-main/graphs/v/${version}/attempts/1/${publication}/graph.json','BUILDING','${lease}',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),'fixture-worker',strftime('%Y-%m-%dT%H:%M:%fZ','now','${claimedOffset}'));`;
}

const outcomeTime = (offset: string) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset}')`;

async function applySql(state: string, file: string) {
  await run(WRANGLER, [
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    CONFIG,
    "--persist-to",
    state,
    "--file",
    file,
  ]);
}

async function startWorker(state: string, workerPort: number) {
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--local",
      "--config",
      CONFIG,
      "--persist-to",
      state,
      "--port",
      String(workerPort),
      "--log-level",
      "error",
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const origin = `http://127.0.0.1:${workerPort}`;
  for (let count = 0; count < 100; count += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early: ${output}`);
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      return { child, origin };
    } catch {
      // Retry only during the bounded startup period.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop(child);
  throw new Error(`Wrangler startup timed out: ${output}`);
}

test("production metrics route executes exact SQL against isolated migration 0020 D1", {
  timeout: 180_000,
}, async () => {
  const state = await mkdtemp(path.join(tmpdir(), "context-hub-metrics-d1-"));
  const sqlDir = await mkdtemp(path.join(tmpdir(), "context-hub-metrics-sql-"));
  let worker: ChildProcess | undefined;
  try {
    const migrations = (await readdir(path.join(ROOT, "apps/api/migrations"))).sort();
    assert.equal(migrations.at(-1), "0020_generalized_project_audit.sql");
    for (const migration of migrations.slice(0, 10))
      await applySql(state, path.join(ROOT, "apps/api/migrations", migration));

    const before0020 = path.join(sqlDir, "before-0020.sql");
    const graphRows = Array.from({ length: 5 }, (_, index) => graphVersion(index + 1)).join(",\n");
    await writeFile(
      before0020,
      `
INSERT INTO users(id,provider,provider_user_id,username) VALUES('user-admin','github','1','admin');
INSERT INTO workspaces(id,name,slug,created_by) VALUES('workspace','Workspace','workspace','user-admin');
INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('workspace','user-admin','ADMIN');
INSERT INTO projects(id,workspace_id,name,slug,created_by,created_at,updated_at) VALUES('project-main','workspace','Main','main','user-admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),('project-other','workspace','Other','other','user-admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO project_members(project_id,user_id,role) VALUES('project-main','user-admin','VIEWER'),('project-other','user-admin','ADMIN');
INSERT INTO graph_versions(id,project_id,version,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version,generator,status,attempt,storage_layout,queued_at,updated_at) VALUES ${graphRows};
${claim(1, "-2 minutes")}
UPDATE graph_build_attempts SET status='PUBLISHED',checksum='${"a".repeat(64)}',byte_size=1000,content_type='application/json',node_count=4,link_count=3,hyperedge_count=0,generated_by=claimed_by,published_at=${outcomeTime("-1 minute")} WHERE graph_version=1;
${claim(2, "-3 minutes")}
UPDATE graph_build_attempts SET status='FAILED',failure_category='FIXTURE',failed_at=${outcomeTime("-1 minute")},orphan_observed_at=${outcomeTime("-1 minute")},cleanup_not_before=${outcomeTime("-1 minute")} WHERE graph_version=2;
${claim(3, "-4 minutes")}
UPDATE graph_build_attempts SET checksum='${"b".repeat(64)}',byte_size=500,content_type='application/json',node_count=2,link_count=1,hyperedge_count=0,generated_by=claimed_by WHERE graph_version=3;
UPDATE graph_build_attempts SET status='FAILED',failure_category='FIXTURE',failed_at=${outcomeTime("-1 minute")},orphan_observed_at=${outcomeTime("-1 minute")},cleanup_not_before=${outcomeTime("-1 minute")} WHERE graph_version=3;
UPDATE graph_build_attempts SET status='CLEANED',cleanup_claim_id='${"c".repeat(32)}',cleanup_claim_expires_at=${outcomeTime("+1 hour")},cleaned_at=${outcomeTime("-30 seconds")},cleanup_result='DELETED' WHERE graph_version=3;
${claim(4, "-9 days")}
UPDATE graph_build_attempts SET status='FAILED',failure_category='OLD',failed_at=${outcomeTime("-8 days")},orphan_observed_at=${outcomeTime("-8 days")},cleanup_not_before=${outcomeTime("-8 days")} WHERE graph_version=4;
${claim(5, "+59 minutes")}
UPDATE graph_build_attempts SET status='FAILED',failure_category='FUTURE',failed_at=${outcomeTime("+1 hour")},orphan_observed_at=${outcomeTime("+1 hour")},cleanup_not_before=${outcomeTime("+1 hour")} WHERE graph_version=5;
`,
    );
    await applySql(state, before0020);
    for (const migration of migrations.slice(10))
      await applySql(state, path.join(ROOT, "apps/api/migrations", migration));

    const token = `metrics-${randomUUID()}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const after0020 = path.join(sqlDir, "after-0020.sql");
    const fixtureTime = new Date().toISOString();
    const futureTime = new Date(Date.now() + 10 * 60_000).toISOString();
    await writeFile(
      after0020,
      `
INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES('session','user-admin','${hash}',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'));
INSERT INTO artifacts(id,project_id,type,name,current_version,status,created_by,created_at,updated_at) VALUES('artifact-main','project-main','architecture','Main',2,'ACTIVE','user-admin','${fixtureTime}','${fixtureTime}'),('artifact-other','project-other','architecture','Other',1,'ACTIVE','user-admin','${fixtureTime}','${fixtureTime}');
INSERT INTO artifact_versions VALUES('artifact-main',1,'projects/project-main/artifacts/artifact-main/v/1/content','${"1".repeat(64)}','text/markdown',100,NULL,NULL,'user-admin','${fixtureTime}'),('artifact-main',2,'projects/project-main/artifacts/artifact-main/v/2/content','${"2".repeat(64)}','text/markdown',250,NULL,NULL,'user-admin','${fixtureTime}'),('artifact-other',1,'projects/project-other/artifacts/artifact-other/v/1/content','${"3".repeat(64)}','text/markdown',900,NULL,NULL,'user-admin','${fixtureTime}');
INSERT INTO audit_events VALUES('artifact-source-1','project-main','artifact-main',1,'artifact-created','user-admin','${fixtureTime}'),('artifact-source-2','project-main','artifact-main',2,'version-created','user-admin','${fixtureTime}');
INSERT INTO snapshot_events VALUES('snapshot-failed','project-main',NULL,'user-admin','snapshot-create','FAILED','FIXTURE','${fixtureTime}');
INSERT INTO snapshot_events VALUES('snapshot-future','project-main',NULL,'user-admin','snapshot-create','FAILED','FUTURE','${futureTime}');
`,
    );
    await applySql(state, after0020);

    const running = await startWorker(state, await port());
    worker = running.child;
    const response = await fetch(`${running.origin}/projects/project-main/metrics?windowDays=7`, {
      headers: { cookie: `context_hub_session=${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as MetricsResponse;
    assert.deepEqual(body.reliability.graphBuild, {
      successes: 1,
      failures: 2,
      sampleCount: 3,
      rate: 1 / 3,
    });
    assert.deepEqual(body.reliability.snapshots, {
      successes: 0,
      failures: 1,
      sampleCount: 1,
      rate: 0,
    });
    assert.equal(body.timing.graphDurationMs.sampleCount, 3);
    assert.ok(Math.abs(body.timing.graphDurationMs.average - 120_000) < 10);
    assert.ok(Math.abs(body.timing.graphDurationMs.minimum - 60_000) < 10);
    assert.ok(Math.abs(body.timing.graphDurationMs.maximum - 180_000) < 10);
    assert.deepEqual(body.immutableObjectMetadata.artifacts, { versions: 2, knownBytes: 350 });
    assert.deepEqual(body.immutableObjectMetadata.graphs, { versions: 1, knownBytes: 1000 });
    assert.equal(body.coverage.auditEvents, 4);
    assert.equal(body.activity.artifactEvents, 2);
    assert.equal(body.onboarding.projectsCreated, 1);
    assert.ok(
      body.coverage.lastEventAt < body.window.to,
      "future upper-bound event must be excluded",
    );
    assert.ok(
      body.coverage.firstEventAt >= body.window.from,
      "lower-bound exclusion must be exact",
    );
    assert.deepEqual(Object.keys(body).sort(), [
      "activity",
      "coverage",
      "immutableObjectMetadata",
      "onboarding",
      "project",
      "reliability",
      "timing",
      "window",
    ]);
    assert.equal(JSON.stringify(body).includes("metadata_json"), false);
  } finally {
    if (worker) await stop(worker);
    await Promise.all([
      rm(state, { recursive: true, force: true }),
      rm(sqlDir, { recursive: true, force: true }),
    ]);
  }
});
