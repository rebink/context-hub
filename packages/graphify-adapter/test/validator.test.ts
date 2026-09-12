import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(HERE, "../python/validate_graph.py");
const FIXTURE = path.join(HERE, "fixtures/graphify-0.9.58.graph.json");
const COMMIT = "9ebc249f02b2a66257816378f73683566aded0ed";
const PATHS = Buffer.from("main.py\0pkg/__init__.py\0pkg/core.py\0");
const NUMERIC_TOKENS = JSON.parse(
  await readFile(path.join(HERE, "../../../test/fixtures/format-v1-numeric-tokens.json"), "utf8"),
) as { accepted: string[]; rejected: string[] };

async function validate(bytes: Buffer, manifest = PATHS) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-validator-"));
  const manifestPath = path.join(root, "manifest.nul");
  await writeFile(manifestPath, manifest);
  const result = spawnSync(
    "python3",
    [VALIDATOR, COMMIT, manifestPath, createHash("sha256").update(manifest).digest("hex")],
    {
      input: bytes,
      maxBuffer: 32 * 1024,
    },
  );
  await rm(root, { recursive: true, force: true });
  return result;
}

test("validator emits only the bounded exact-byte integrity handshake", async () => {
  const fixture = await readFile(FIXTURE);
  const result = await validate(fixture);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), {
    byteSize: 5242,
    contentChecksumSha256: "25a9311a26ea28bf3d87a1cf186e4f1d10e962381bc39fdc815687dea57f085c",
    hyperedgeCount: 0,
    linkCount: 10,
    nodeCount: 7,
  });
  assert.ok(result.stdout.byteLength < 4096);
});

test("validator fails closed across duplicate, schema, bound, path, endpoint, confidence, and location cases", async () => {
  const fixture = await readFile(FIXTURE, "utf8");
  interface MutableGraph {
    directed: boolean;
    built_at_commit: string;
    graph: Record<string, unknown>;
    nodes: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
    hyperedges: unknown[];
    [key: string]: unknown;
  }
  const parsed = JSON.parse(fixture) as MutableGraph;
  const changed = (mutate: (value: MutableGraph) => void): Buffer => {
    const value = structuredClone(parsed);
    mutate(value);
    return Buffer.from(JSON.stringify(value));
  };
  const node = (value: MutableGraph, index = 0): Record<string, unknown> => {
    const item = value.nodes[index];
    if (!item) throw new Error("fixture node missing");
    return item;
  };
  const link = (value: MutableGraph): Record<string, unknown> => {
    const item = value.links[0];
    if (!item) throw new Error("fixture link missing");
    return item;
  };
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let index = 0; index < 13; index += 1) {
    cursor.next = {};
    cursor = cursor.next as Record<string, unknown>;
  }
  const cases: Array<[string, Buffer]> = [
    [
      "escaped-equivalent duplicate key",
      Buffer.from(
        fixture.replace('"directed": false', '"directed": false, "\\u0064irected": false'),
      ),
    ],
    ["malformed UTF-8", Buffer.from([0xff, 0xfe])],
    [
      "wrong flags",
      changed((value) => {
        value.directed = true;
      }),
    ],
    [
      "wrong commit",
      changed((value) => {
        value.built_at_commit = "0".repeat(40);
      }),
    ],
    [
      "unknown top-level",
      changed((value) => {
        value.edges = [];
      }),
    ],
    [
      "nonempty hyperedges",
      changed((value) => {
        value.hyperedges = [{}];
      }),
    ],
    [
      "duplicate IDs",
      changed((value) => {
        node(value, 1).id = node(value).id;
      }),
    ],
    [
      "bad endpoint",
      changed((value) => {
        link(value).target = "missing";
      }),
    ],
    [
      "bad confidence",
      changed((value) => {
        link(value).confidence = "CERTAIN";
      }),
    ],
    [
      "bad location",
      changed((value) => {
        node(value).source_location = "line 1";
      }),
    ],
    [
      "untracked path",
      changed((value) => {
        node(value).source_file = "unknown.py";
      }),
    ],
    [
      "traversal path",
      changed((value) => {
        node(value).source_file = "../main.py";
      }),
    ],
    [
      "Windows drive path",
      changed((value) => {
        node(value).source_file = "C:main.py";
      }),
    ],
    [
      "nested unknown",
      changed((value) => {
        node(value).extension = {};
      }),
    ],
    [
      "oversized field",
      changed((value) => {
        node(value).label = "x".repeat(513);
      }),
    ],
    [
      "negative community",
      changed((value) => {
        node(value).community = -1;
      }),
    ],
    [
      "oversized numeric form",
      Buffer.from(
        fixture.replace('"confidence_score": 1.0', `"confidence_score": 1e${"9".repeat(129)}`),
      ),
    ],
    [
      "excessive depth",
      changed((value) => {
        value.graph.deep = deep;
      }),
    ],
  ];
  for (const [name, bytes] of cases) {
    const result = await validate(bytes);
    assert.notEqual(result.status, 0, name);
    assert.equal(result.stdout.byteLength, 0, name);
  }
});

test("validator enforces the shared finite binary64 numeric lexical and 128-character contract", async () => {
  const fixture = await readFile(FIXTURE, "utf8");
  for (const token of NUMERIC_TOKENS.accepted) {
    const result = await validate(
      Buffer.from(fixture.replace('"weight": 1.0', `"weight": ${token}`)),
    );
    assert.equal(result.status, 0, `accepted ${token}`);
  }
  for (const token of NUMERIC_TOKENS.rejected) {
    const result = await validate(
      Buffer.from(fixture.replace('"weight": 1.0', `"weight": ${token}`)),
    );
    assert.notEqual(result.status, 0, `rejected ${token}`);
    assert.equal(result.stdout.byteLength, 0, `rejected ${token}`);
  }
});

test("validator rejects a tracked Windows drive-form source path on POSIX", async () => {
  const fixture = await readFile(FIXTURE, "utf8");
  const bytes = Buffer.from(fixture.replaceAll('"main.py"', '"C:main.py"'));
  const manifest = Buffer.from("C:main.py\0pkg/__init__.py\0pkg/core.py\0");
  const result = await validate(bytes, manifest);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.byteLength, 0);
});

test("validator binds the hashed tracked-file manifest", async () => {
  const fixture = await readFile(FIXTURE);
  const result = await validate(fixture, Buffer.from("main.py\0"));
  assert.notEqual(result.status, 0);
});
