#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_FREE_COMPRESSED_BYTES = 3 * 1024 * 1024;
const WORKER_TOOLING_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

function filesBelow(directory, predicate = () => true) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(path, predicate));
    else if (predicate(path)) result.push(path);
  }
  return result.sort();
}

function sourceFiles(directory) {
  return filesBelow(directory, (path) => path.endsWith(".ts") && !path.includes("/test/"));
}

function occurrences(paths, pattern) {
  return paths.reduce(
    (count, path) => count + (readFileSync(path, "utf8").match(pattern) ?? []).length,
    0,
  );
}

function constant(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match?.[1]) throw new Error(`Missing ${name}`);
  const expression = match[1].replaceAll("_", "").replaceAll("*", "*");
  if (!/^[\d\s*+]+$/.test(expression)) throw new Error(`Non-numeric ${name}`);
  return Function(`"use strict"; return (${expression})`)();
}

function workflow(path) {
  const text = readFileSync(path, "utf8");
  return {
    file: relative(root, path),
    triggers: ["pull_request", "push", "workflow_dispatch"].filter((trigger) =>
      new RegExp(`^  ${trigger}:`, "m").test(text),
    ),
    timeoutMinutes: [...text.matchAll(/timeout-minutes:\s*(\d+)/g)].map((match) =>
      Number(match[1]),
    ),
    concurrencyGroup: text.match(/group:\s*([^\n]+)/)?.[1]?.trim() ?? null,
    cancelInProgress: text.match(/cancel-in-progress:\s*(true|false)/)?.[1] ?? null,
    artifactRetentionDays: [...text.matchAll(/retention-days:\s*(\d+)/g)].map((match) =>
      Number(match[1]),
    ),
    uploadsActionsArtifacts: /(?:actions\/upload-artifact|upload-pages-artifact)@/.test(text),
  };
}

function wranglerUploadMeasurement() {
  const temp = mkdtempSync(join(tmpdir(), "context-hub-worker-upload-"));
  try {
    const output = execFileSync(
      join(root, "node_modules/.bin/wrangler"),
      ["deploy", "--dry-run", "--outdir", temp, "--env="],
      { cwd: join(root, "apps/api"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const match = output.match(/Total Upload:\s*([\d.]+) KiB\s*\/\s*gzip:\s*([\d.]+) KiB/);
    if (!match) throw new Error("Unable to parse Wrangler upload measurement");
    return {
      totalUploadBytes: Math.round(Number(match[1]) * 1024),
      compressedUploadBytes: Math.round(Number(match[2]) * 1024),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function builtOutput() {
  const workerPath = join(root, "apps/api/dist/index.js");
  const worker = readFileSync(workerPath);
  const assets = filesBelow(join(root, "apps/web/dist"));
  const sizes = assets.map((path) => ({
    path: relative(join(root, "apps/web/dist"), path),
    bytes: statSync(path).size,
  }));
  return {
    worker: {
      path: relative(root, workerPath),
      uncompressedBytes: worker.byteLength,
      localGzipBytes: gzipSync(worker, { level: 9 }).byteLength,
      wrangler: wranglerUploadMeasurement(),
      limits: {
        freeCompressedUploadBytes: WORKER_FREE_COMPRESSED_BYTES,
        toolingUncompressedBytes: WORKER_TOOLING_UNCOMPRESSED_BYTES,
      },
    },
    pages: {
      fileCount: sizes.length,
      totalBytes: sizes.reduce((sum, item) => sum + item.bytes, 0),
      largest: sizes.sort((left, right) => right.bytes - left.bytes)[0] ?? null,
    },
  };
}

function productionQueryPlans() {
  const program = `
    import { crossProjectContextSql } from "./apps/api/src/context-engine.ts";
    import { snapshotArtifactReferenceSql } from "./apps/api/src/snapshots.ts";
    const terms=Array.from({length:32},(_,i)=>"term-"+i);
    const projects=Array.from({length:20},(_,i)=>"project-"+i);
    console.log(JSON.stringify({
      contextArtifacts: {
        sql: crossProjectContextSql(20,32).artifacts+
          " ORDER BY metadata_score DESC,candidate_rank,project_id,id LIMIT ?",
        args:[...terms,...projects,9]
      },
      snapshotArtifacts: {
        sql:snapshotArtifactReferenceSql(20),
        args:[...Array.from({length:20},(_,i)=>["artifact-"+i,1]).flat(),"project-0"]
      }
    }));
  `;
  return JSON.parse(
    execFileSync(join(root, "node_modules/.bin/tsx"), ["-e", program], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

function migratedDatabase() {
  const temp = mkdtempSync(join(tmpdir(), "context-hub-free-tier-"));
  try {
    execFileSync(
      join(root, "node_modules/.bin/wrangler"),
      [
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        temp,
        "--config",
        join(root, "apps/api/wrangler.toml"),
      ],
      { stdio: "ignore" },
    );
    const sqlite = filesBelow(
      temp,
      (path) => path.endsWith(".sqlite") && basename(path) !== "metadata.sqlite",
    )[0];
    if (!sqlite) throw new Error("Wrangler did not create a local SQLite database");
    const productionPlans = productionQueryPlans();
    const python = `
import json, os, sqlite3, sys
path=sys.argv[1]
production=json.loads(sys.argv[2])
db=sqlite3.connect(path)
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
plans={
 'artifact_list': "EXPLAIN QUERY PLAN SELECT id FROM artifacts WHERE project_id='p' AND status='ACTIVE' ORDER BY created_at DESC,id DESC LIMIT 100",
 'snapshot_list': "EXPLAIN QUERY PLAN SELECT id FROM context_snapshots WHERE project_id='p' ORDER BY created_at DESC,id DESC LIMIT 5",
 'activity_list': "EXPLAIN QUERY PLAN SELECT id FROM project_audit_events WHERE project_id='p' ORDER BY occurred_at DESC,id DESC LIMIT 51",
 'graph_latest': "EXPLAIN QUERY PLAN SELECT id FROM graph_versions WHERE project_id='p' AND status='READY' ORDER BY version DESC LIMIT 1",
 'sync_latest': ("EXPLAIN QUERY PLAN SELECT project_id FROM sync_states WHERE project_id='p' ORDER BY last_seen_at DESC,principal_id DESC,client_id DESC LIMIT 1", []),
 'context_artifacts_production': ("EXPLAIN QUERY PLAN "+production['contextArtifacts']['sql'], production['contextArtifacts']['args']),
 'snapshot_artifacts_production': ("EXPLAIN QUERY PLAN "+production['snapshotArtifacts']['sql'], production['snapshotArtifacts']['args']),
}
plans={name: value if isinstance(value, tuple) else (value, []) for name,value in plans.items()}
output={
 'databaseBytes': os.path.getsize(path),
 'pageSize': db.execute('PRAGMA page_size').fetchone()[0],
 'pageCount': db.execute('PRAGMA page_count').fetchone()[0],
 'tableCount': db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0],
 'indexCount': db.execute("SELECT count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").fetchone()[0],
 'projectFirstIndexCount': db.execute("SELECT count(*) FROM sqlite_master WHERE type='index' AND sql GLOB '*(*project_id*'").fetchone()[0],
 'queryPlans': {name: [row[3] for row in db.execute(sql,args)] for name,(sql,args) in plans.items()},
}
print(json.dumps(output))
`;
    return JSON.parse(
      execFileSync("python3", ["-c", python, sqlite, JSON.stringify(productionPlans)], {
        encoding: "utf8",
      }),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function sourceAudit() {
  const api = sourceFiles(join(root, "apps/api/src"));
  const web = sourceFiles(join(root, "apps/web/src"));
  const cli = sourceFiles(join(root, "packages/context-cli/src"));
  const pi = sourceFiles(join(root, "packages/context-pi/src"));
  const snapshotSource = readFileSync(join(root, "apps/api/src/snapshots.ts"), "utf8");
  const contextSource = readFileSync(join(root, "apps/api/src/context-engine.ts"), "utf8");
  const graphCi = readFileSync(join(root, "scripts/graphify-ci.ts"), "utf8");
  const migrations = filesBelow(join(root, "apps/api/migrations"), (path) => path.endsWith(".sql"));
  const migrationText = migrations.map((path) => readFileSync(path, "utf8")).join("\n");
  const maxSnapshotArtifacts = constant(snapshotSource, "MAX_ARTIFACTS");
  const maxSnapshotPage = constant(snapshotSource, "MAX_LIMIT");
  const perSnapshotR2 = 4 + 2 * maxSnapshotArtifacts;
  const snapshotCreateD1 = 8 + maxSnapshotArtifacts;
  return {
    classifications: {
      measuredLocally: ["built.worker", "built.pages", "migration", "staticEvidence"],
      calculatedWorstCase: ["operationModels"],
      deployedTelemetryUnknown: [
        "Worker requests and CPU time",
        "D1 rows read/written and remote query plans",
        "R2 storage/Class A/Class B operations and orphan inventory",
        "Pages builds and account concurrency",
        "Actions billed minutes/storage, repository visibility, and owner plan",
      ],
    },
    workflows: [
      workflow(join(root, ".github/workflows/ci.yml")),
      workflow(join(root, ".github/workflows/graphify.yml")),
    ],
    appLimits: {
      snapshotArtifacts: maxSnapshotArtifacts,
      snapshotPage: maxSnapshotPage,
      contextProjects: constant(contextSource, "MAX_PROJECTS"),
      contextArtifactCandidatesSingleProject: constant(contextSource, "MAX_ARTIFACT_CANDIDATES"),
      contextArtifactCandidatesCrossProject: constant(
        contextSource,
        "MAX_CROSS_PROJECT_ARTIFACT_CANDIDATES",
      ),
      contextGraphEvidenceCrossProject: constant(contextSource, "MAX_CROSS_PROJECT_GRAPH_EVIDENCE"),
    },
    operationModels: {
      snapshotCreate: {
        d1QueriesAtMax: snapshotCreateD1,
        observedRouteQueries: {
          normal: snapshotCreateD1,
          collision: 8,
          ambiguousWrite: snapshotCreateD1,
          d1FailureRecovery: 30,
          concurrentReplayRecovery: 13,
        },
        r2OperationsAtMax: 5 + 2 * maxSnapshotArtifacts,
        formula:
          "Normal routed create: authentication, membership, idempotency, graph, one bounded artifact query, D1 time, and A+2 batch statements; executable route regressions fail on query 51",
      },
      snapshotInspect: {
        d1QueriesAtMax: 5,
        r2OperationsAtMax: perSnapshotR2,
        formula:
          "D1 <= membership + row + captured refs + graph + joined current refs; R2 <= 4 + 2A",
      },
      snapshotList: {
        d1QueriesAtMax: 2 + 3 * maxSnapshotPage,
        r2OperationsAtMax: maxSnapshotPage * perSnapshotR2,
        serviceBindingOperationsAtMax: 2 + maxSnapshotPage * (3 + perSnapshotR2),
        formula: "D1 <= membership + page + 3S; R2 <= S(4 + 2A)",
      },
      contextOneProject: {
        d1QueriesAtMax: 43,
        r2OperationsAtMax: 32,
        formula:
          "authenticate+membership <= 2; source metadata/fences <= 9; at most 16 source objects each use immediate pre-HEAD/pre-GET D1 checks",
      },
      contextTwentyProjectHuman: {
        d1QueriesAtMax: 41,
        r2OperationsAtMax: 32,
        formula:
          "createApp route wrapper observes 41: authentication + complete-set authorization + the 39-query engine path",
      },
      contextTwentyProjectMcp: {
        d1QueriesAtMax: 46,
        r2OperationsAtMax: 32,
        boundParametersAtMax: 100,
        formula:
          "repository-bound handleMcpRoute wrapper observes eight queries for project_info, including its one domain query; its seven-query transport plus the 39-query repository-bound engine path is 46",
      },
    },
    staticEvidence: {
      productionSetIntervalCalls: occurrences(
        [...api, ...web, ...cli, ...pi],
        /\bsetInterval\s*\(/g,
      ),
      webSetTimeoutCalls: occurrences(web, /\bsetTimeout\s*\(/g),
      graphPublishRetryAttempts: Number(graphCi.match(/attempts = (\d+)/)?.[1] ?? NaN),
      snapshotIntegrityUsesJoinedCurrentReferences:
        snapshotSource.includes("FROM snapshot_artifacts sa") &&
        snapshotSource.includes("currentSnapshotArtifacts"),
      completeGraphIdentityDeduplication: migrationText.includes(
        "repository_canonical_url, source_commit_sha, graphify_version",
      ),
      createOnlyObjectWrites: occurrences(api, /\.createOnly\s*\(/g),
      migrationCount: migrations.length,
    },
  };
}

export function auditRepository({ sourceOnly = false } = {}) {
  const audit = sourceAudit();
  if (audit.staticEvidence.productionSetIntervalCalls !== 0)
    throw new Error("Production polling detected");
  if (audit.operationModels.snapshotCreate.d1QueriesAtMax > 50)
    throw new Error("Snapshot create exceeds D1 query ceiling");
  if (audit.operationModels.snapshotList.serviceBindingOperationsAtMax > 1000)
    throw new Error("Snapshot list exceeds Worker service-subrequest ceiling");
  if (
    audit.operationModels.contextTwentyProjectHuman.d1QueriesAtMax > 50 ||
    audit.operationModels.contextTwentyProjectMcp.d1QueriesAtMax > 50 ||
    audit.operationModels.contextTwentyProjectMcp.boundParametersAtMax > 100
  )
    throw new Error("Twenty-project context exceeds D1 query ceiling");
  if (audit.workflows.some((item) => item.timeoutMinutes.length === 0))
    throw new Error("Workflow timeout missing");
  if (sourceOnly) return audit;
  const built = builtOutput();
  if (built.worker.wrangler.compressedUploadBytes > WORKER_FREE_COMPRESSED_BYTES)
    throw new Error("Worker exceeds the Free compressed upload ceiling");
  if (built.worker.uncompressedBytes > WORKER_TOOLING_UNCOMPRESSED_BYTES)
    throw new Error("Worker exceeds the 64 MiB uncompressed tooling ceiling");
  return { ...audit, built, migration: migratedDatabase() };
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const sourceOnly = process.argv.includes("--source-only");
  process.stdout.write(`${JSON.stringify(auditRepository({ sourceOnly }), null, 2)}\n`);
}
