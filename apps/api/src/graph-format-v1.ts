const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_KEYS = 64;
const MAX_KEY_BYTES = 64;
const MAX_STRING_BYTES = 4096;
const MAX_FIELD_BYTES = 512;
const MAX_PATH_BYTES = 1024;
const MAX_LOCATION_BYTES = 32;
const MAX_NODES = 50_000;
const MAX_LINKS = 100_000;
const MAX_NUMBER_CHARS = 128;

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type GraphNode = { [key: string]: JsonValue; id: string };
export type GraphLink = { [key: string]: JsonValue; source: string; target: string };
export type ValidatedGraph = { nodes: GraphNode[]; links: GraphLink[] };

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
const isObject = (value: unknown): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isScalar = (value: unknown): value is JsonScalar =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/** A small JSON parser is used because JSON.parse discards duplicate object keys. */
class DuplicateAwareJsonParser {
  private offset = 0;
  private numberHadIntegerSyntax = false;
  private readonly integerFields = new WeakMap<object, Set<string>>();

  constructor(private readonly text: string) {}

  isIntegerField(record: object, key: string): boolean {
    return this.integerFields.get(record)?.has(key) ?? false;
  }

  parse(): JsonValue {
    this.space();
    const value = this.value(1);
    this.space();
    if (this.offset !== this.text.length) throw new Error("trailing input");
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) throw new Error("depth");
    this.space();
    const char = this.text[this.offset];
    if (char === '"') return this.string();
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === "t" && this.take("true")) return true;
    if (char === "f" && this.take("false")) return false;
    if (char === "n" && this.take("null")) return null;
    return this.number();
  }

  private object(depth: number): { [key: string]: JsonValue } {
    this.offset += 1;
    this.space();
    const result: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      if (this.text[this.offset] !== '"') throw new Error("object key");
      const key = this.string();
      if (utf8Length(key) > MAX_KEY_BYTES || keys.has(key) || keys.size >= MAX_KEYS)
        throw new Error("object key bound");
      keys.add(key);
      this.space();
      if (this.text[this.offset] !== ":") throw new Error("colon");
      this.offset += 1;
      const member = this.value(depth + 1);
      result[key] = member;
      if (typeof member === "number" && this.numberHadIntegerSyntax) {
        const fields = this.integerFields.get(result) ?? new Set<string>();
        fields.add(key);
        this.integerFields.set(result, fields);
      }
      this.space();
      const char = this.text[this.offset++];
      if (char === "}") return result;
      if (char !== ",") throw new Error("object separator");
      this.space();
    }
  }

  private array(depth: number): JsonValue[] {
    this.offset += 1;
    this.space();
    const result: JsonValue[] = [];
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth + 1));
      this.space();
      const char = this.text[this.offset++];
      if (char === "]") return result;
      if (char !== ",") throw new Error("array separator");
      this.space();
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        const value = JSON.parse(this.text.slice(start, this.offset)) as string;
        for (let index = 0; index < value.length; index += 1) {
          const code = value.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("unpaired surrogate");
            index += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("unpaired surrogate");
        }
        if (utf8Length(value) > MAX_STRING_BYTES) throw new Error("string bound");
        return value;
      }
      if (code < 0x20) throw new Error("control character");
      if (code === 0x5c) {
        this.offset += 1;
        const escapeCode = this.text[this.offset];
        if (!escapeCode || !'"\\/bfnrtu'.includes(escapeCode)) throw new Error("escape");
        if (escapeCode === "u") {
          const hex = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("unicode escape");
          this.offset += 4;
        }
      }
      this.offset += 1;
    }
    throw new Error("unterminated string");
  }

  private number(): number {
    const rest = this.text.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) throw new Error("number");
    if (match[0].length > MAX_NUMBER_CHARS) throw new Error("number bound");
    this.offset += match[0].length;
    this.numberHadIntegerSyntax = !/[.eE]/.test(match[0]);
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("finite number");
    return value;
  }

  private take(token: string): boolean {
    if (!this.text.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }

  private space(): void {
    while ([" ", "\t", "\r", "\n"].includes(this.text[this.offset] ?? "")) this.offset += 1;
  }
}

function boundedString(value: JsonValue | undefined, max = MAX_FIELD_BYTES): value is string {
  return typeof value === "string" && utf8Length(value) <= max;
}

function validSourcePath(value: JsonValue | undefined): value is string {
  if (!boundedString(value, MAX_PATH_BYTES) || value.length === 0 || value.includes("\0"))
    return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function validLocation(value: JsonValue | undefined): value is string {
  return boundedString(value, MAX_LOCATION_BYTES) && /^L[1-9][0-9]*$/.test(value);
}

function validExtensions(
  record: { [key: string]: JsonValue },
  known: ReadonlySet<string>,
): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (known.has(key)) continue;
    if (!isScalar(value) || (typeof value === "string" && utf8Length(value) > MAX_STRING_BYTES))
      return false;
  }
  return true;
}

const NODE_FIELDS = new Set([
  "id",
  "label",
  "file_type",
  "source_file",
  "source_location",
  "_origin",
  "community",
  "community_name",
  "norm_label",
  "_callable",
  "_callable_class",
]);
const LINK_FIELDS = new Set([
  "source",
  "target",
  "relation",
  "confidence",
  "confidence_score",
  "weight",
  "source_file",
  "source_location",
  "_origin",
  "context",
]);

function validNode(
  record: { [key: string]: JsonValue },
  parser: DuplicateAwareJsonParser,
): record is GraphNode {
  if (
    !boundedString(record.id) ||
    record.id.length === 0 ||
    !boundedString(record.label) ||
    !boundedString(record.file_type) ||
    !validSourcePath(record.source_file) ||
    !validLocation(record.source_location)
  )
    return false;
  for (const name of ["_origin", "community_name", "norm_label"])
    if (record[name] !== undefined && !boundedString(record[name])) return false;
  if (
    record.community !== undefined &&
    (typeof record.community !== "number" ||
      !parser.isIntegerField(record, "community") ||
      record.community < 0)
  )
    return false;
  for (const name of ["_callable", "_callable_class"])
    if (record[name] !== undefined && typeof record[name] !== "boolean") return false;
  return validExtensions(record, NODE_FIELDS);
}

function validLink(record: { [key: string]: JsonValue }): record is GraphLink {
  if (
    !boundedString(record.source) ||
    record.source.length === 0 ||
    !boundedString(record.target) ||
    record.target.length === 0 ||
    !boundedString(record.relation) ||
    record.relation.length === 0 ||
    !boundedString(record.confidence) ||
    !["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(record.confidence) ||
    typeof record.confidence_score !== "number" ||
    !Number.isFinite(record.confidence_score) ||
    typeof record.weight !== "number" ||
    !Number.isFinite(record.weight) ||
    !validSourcePath(record.source_file) ||
    !validLocation(record.source_location)
  )
    return false;
  for (const name of ["_origin", "context"])
    if (record[name] !== undefined && !boundedString(record[name])) return false;
  return validExtensions(record, LINK_FIELDS);
}

export function validateGraphFormatV1(
  bytes: Uint8Array<ArrayBuffer>,
  expectedCommit: string,
): ValidatedGraph | null {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_GRAPH_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parser = new DuplicateAwareJsonParser(text);
    const value = parser.parse();
    if (!isObject(value)) return null;
    const exactKeys = [
      "directed",
      "multigraph",
      "graph",
      "nodes",
      "links",
      "hyperedges",
      "built_at_commit",
    ];
    if (Object.keys(value).length !== exactKeys.length || exactKeys.some((key) => !(key in value)))
      return null;
    if (
      value.directed !== false ||
      value.multigraph !== false ||
      !isObject(value.graph) ||
      !validExtensions(value.graph, new Set()) ||
      !Array.isArray(value.nodes) ||
      value.nodes.length > MAX_NODES ||
      !Array.isArray(value.links) ||
      value.links.length > MAX_LINKS ||
      !Array.isArray(value.hyperedges) ||
      value.hyperedges.length !== 0 ||
      value.built_at_commit !== expectedCommit ||
      !/^[0-9a-f]{40}$/.test(expectedCommit)
    )
      return null;
    const nodes: GraphNode[] = [];
    const ids = new Set<string>();
    for (const valueNode of value.nodes) {
      if (!isObject(valueNode) || !validNode(valueNode, parser) || ids.has(valueNode.id))
        return null;
      ids.add(valueNode.id);
      nodes.push(valueNode);
    }
    const links: GraphLink[] = [];
    for (const valueLink of value.links) {
      if (
        !isObject(valueLink) ||
        !validLink(valueLink) ||
        !ids.has(valueLink.source) ||
        !ids.has(valueLink.target)
      )
        return null;
      links.push(valueLink);
    }
    return { nodes, links };
  } catch {
    return null;
  }
}
