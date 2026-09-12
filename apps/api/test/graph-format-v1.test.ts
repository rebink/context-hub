/* biome-ignore-all lint/suspicious/noExplicitAny: Malformed fixture mutations intentionally cross schema types. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateGraphFormatV1 } from "../src/graph-format-v1.js";

const COMMIT = "a".repeat(40);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NUMERIC_TOKENS = JSON.parse(
  readFileSync(path.join(HERE, "../../../test/fixtures/format-v1-numeric-tokens.json"), "utf8"),
) as { accepted: string[]; rejected: string[] };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function validGraph(): any {
  return {
    directed: false,
    multigraph: false,
    graph: { language: "typescript", enabled: true, ratio: 1, absent: null },
    nodes: [
      {
        id: "a",
        label: "Alpha",
        file_type: "ts",
        source_file: "src/a.ts",
        source_location: "L1",
        _origin: "parser",
        community: 0,
        community_name: "root",
        norm_label: "alpha",
        _callable: true,
        _callable_class: false,
        extension: "kept",
      },
      {
        id: "b",
        label: "Beta",
        file_type: "ts",
        source_file: "src/b.ts",
        source_location: "L2",
      },
    ],
    links: [
      {
        source: "a",
        target: "b",
        relation: "CALLS",
        confidence: "EXTRACTED",
        confidence_score: 1,
        weight: 1,
        source_file: "src/a.ts",
        source_location: "L1",
        _origin: "parser",
        context: "call",
        extension: null,
      },
    ],
    hyperedges: [],
    built_at_commit: COMMIT,
  };
}

describe("Worker format-v1 validator", () => {
  it("accepts the complete schema and exact UTF-8 maxima", () => {
    const graph = validGraph();
    graph.nodes[0].id = "x".repeat(512);
    graph.nodes[0].label = "y".repeat(512);
    graph.nodes[0].source_file = `${"a".repeat(1020)}/b.c`;
    graph.nodes[0].source_location = `L${"1".repeat(31)}`;
    graph.nodes[0].extension = "z".repeat(4096);
    graph.graph = { ["k".repeat(64)]: "v".repeat(4096) };
    graph.links[0].source = graph.nodes[0].id;
    graph.links[0].relation = "r".repeat(512);
    assert.ok(validateGraphFormatV1(encode(graph), COMMIT));
  });

  it("rejects duplicate keys before map materialization and malformed UTF-8/JSON", () => {
    const json = JSON.stringify(validGraph());
    const duplicate = json.replace('"directed":false', '"directed":false,"\\u0064irected":false');
    assert.equal(validateGraphFormatV1(new TextEncoder().encode(duplicate), COMMIT), null);
    assert.equal(validateGraphFormatV1(Uint8Array.from([0x7b, 0xff, 0x7d]), COMMIT), null);
    assert.equal(validateGraphFormatV1(new TextEncoder().encode('{"x":NaN}'), COMMIT), null);
    assert.equal(validateGraphFormatV1(new TextEncoder().encode(`${json}\v`), COMMIT), null);
    assert.equal(
      validateGraphFormatV1(new TextEncoder().encode(json.replace('"Alpha"', '"\\ud800"')), COMMIT),
      null,
    );
  });

  it("rejects top-level, structural, count, key, scalar, and depth violations", () => {
    const cases: Array<(graph: ReturnType<typeof validGraph>) => void> = [
      (graph) => Object.assign(graph, { edges: [] }),
      (graph) => {
        graph.directed = true;
      },
      (graph) => {
        graph.hyperedges = [{}];
      },
      (graph) => {
        graph.graph = { nested: {} } as never;
      },
      (graph) => {
        graph.nodes[0].extension = [] as never;
      },
      (graph) => {
        graph.graph = Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`k${index}`, index]),
        );
      },
      (graph) => {
        graph.graph = { ["k".repeat(65)]: true };
      },
      (graph) => {
        graph.nodes[0].extension = "x".repeat(4097);
      },
    ];
    for (const change of cases) {
      const graph = validGraph();
      change(graph);
      assert.equal(validateGraphFormatV1(encode(graph), COMMIT), null);
    }
    let nested = "null";
    for (let index = 0; index < 12; index += 1) nested = `[${nested}]`;
    const depth = JSON.stringify(validGraph()).replace(
      '"graph":{"language":"typescript","enabled":true,"ratio":1,"absent":null}',
      `"graph":{"deep":${nested}}`,
    );
    assert.equal(validateGraphFormatV1(new TextEncoder().encode(depth), COMMIT), null);
    assert.equal(validateGraphFormatV1(new Uint8Array(8 * 1024 * 1024 + 1), COMMIT), null);
  });

  it("rejects malformed required fields, optional types, IDs, endpoints, numbers, confidence, and location", () => {
    const cases: Array<(graph: ReturnType<typeof validGraph>) => void> = [
      (graph) => {
        graph.nodes[0].id = "";
      },
      (graph) => {
        graph.nodes[1].id = "a";
      },
      (graph) => {
        graph.nodes[0].label = "x".repeat(513);
      },
      (graph) => {
        graph.nodes[0].community = -1;
      },
      (graph) => {
        graph.nodes[0].community = 1.5;
      },
      (graph) => {
        graph.nodes[0]._callable = "true" as never;
      },
      (graph) => {
        graph.links[0].target = "missing";
      },
      (graph) => {
        graph.links[0].relation = "";
      },
      (graph) => {
        graph.links[0].confidence = "CERTAIN";
      },
      (graph) => {
        graph.links[0].confidence_score = "1" as never;
      },
      (graph) => {
        graph.links[0].source_location = "line 1";
      },
      (graph) => {
        graph.built_at_commit = "A".repeat(40);
      },
    ];
    for (const change of cases) {
      const graph = validGraph();
      change(graph);
      assert.equal(validateGraphFormatV1(encode(graph), COMMIT), null);
    }
    const json = JSON.stringify(validGraph()).replace('"weight":1', '"weight":1e999');
    assert.equal(validateGraphFormatV1(new TextEncoder().encode(json), COMMIT), null);
    const decimalCommunity = JSON.stringify(validGraph()).replace(
      '"community":0',
      '"community":0.0',
    );
    assert.equal(validateGraphFormatV1(new TextEncoder().encode(decimalCommunity), COMMIT), null);
  });

  it("enforces the shared finite binary64 numeric lexical and 128-character contract", () => {
    const raw = JSON.stringify(validGraph());
    for (const token of NUMERIC_TOKENS.accepted) {
      const bytes = new TextEncoder().encode(raw.replace('"weight":1', `"weight":${token}`));
      assert.ok(validateGraphFormatV1(bytes, COMMIT), `accepted ${token}`);
    }
    for (const token of NUMERIC_TOKENS.rejected) {
      const bytes = new TextEncoder().encode(raw.replace('"weight":1', `"weight":${token}`));
      assert.equal(validateGraphFormatV1(bytes, COMMIT), null, `rejected ${token}`);
    }
  });

  it("accepts the node-count maximum and rejects one record beyond it", () => {
    const graph = validGraph();
    graph.nodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `n${index}`,
      label: "n",
      file_type: "t",
      source_file: "s",
      source_location: "L1",
    }));
    graph.links = [];
    assert.ok(validateGraphFormatV1(encode(graph), COMMIT));
    graph.nodes.push({
      id: "overflow",
      label: "n",
      file_type: "t",
      source_file: "s",
      source_location: "L1",
    });
    assert.equal(validateGraphFormatV1(encode(graph), COMMIT), null);
  });

  it("requires schema-safe normalized relative POSIX source paths", () => {
    for (const path of [
      "",
      "/src/a.ts",
      "C:/src/a.ts",
      "C:\\src\\a.ts",
      "src\\a.ts",
      "src//a.ts",
      "src/./a.ts",
      "src/../a.ts",
      "src/a.ts\0tail",
      "x".repeat(1025),
    ]) {
      const graph = validGraph();
      graph.nodes[0].source_file = path;
      assert.equal(validateGraphFormatV1(encode(graph), COMMIT), null, path);
    }
  });
});
