#!/usr/bin/env python3
"""Strict stdlib-only validator. stdout is a bounded integrity handshake only."""

import hashlib
import json
import math
import re
import sys
from decimal import Decimal, InvalidOperation

MAX_BYTES = 8 * 1024 * 1024
MAX_NUMBER_CHARS = 128
SMALL_FIELDS = {
    "id", "label", "relation", "context", "file_type", "_origin", "norm_label",
    "confidence", "community_name",
}
TOP_KEYS = {"directed", "multigraph", "graph", "nodes", "links", "hyperedges", "built_at_commit"}
NODE_REQUIRED = {"id", "label", "file_type", "source_file", "source_location"}
NODE_OPTIONAL = {"_origin", "community", "community_name", "norm_label", "_callable", "_callable_class"}
LINK_REQUIRED_STR = {"source", "target", "relation", "confidence", "source_file", "source_location"}
LINK_REQUIRED_NUM = {"confidence_score", "weight"}
LINK_OPTIONAL = {"_origin", "context"}
COMMIT = re.compile(r"^[0-9a-f]{40}$")
LOCATION = re.compile(r"^L[1-9][0-9]*$")

class Invalid(Exception):
    pass

class ObjPairs(list):
    pass

def pairs_hook(pairs):
    seen = set()
    for key, _ in pairs:
        if key in seen:
            raise Invalid()
        seen.add(key)
    return ObjPairs(pairs)

def finite_binary64(value):
    if len(value) > MAX_NUMBER_CHARS or not value.isascii():
        raise Invalid()
    try:
        converted = float(value)
    except (OverflowError, ValueError) as exc:
        raise Invalid() from exc
    if not math.isfinite(converted):
        raise Invalid()

def number(value):
    finite_binary64(value)
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise Invalid() from exc
    return parsed

def integer(value):
    finite_binary64(value)
    return int(value)

def reject_constant(_value):
    raise Invalid()

def to_dict(obj):
    return dict(obj)

def byte_len(value):
    return len(value.encode("utf-8"))

def validate_tree(value, depth=1):
    if depth > 12:
        raise Invalid()
    if isinstance(value, ObjPairs):
        if len(value) > 64:
            raise Invalid()
        for key, child in value:
            if not isinstance(key, str) or byte_len(key) > 64:
                raise Invalid()
            validate_tree(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            validate_tree(child, depth + 1)
    elif isinstance(value, str):
        if byte_len(value) > 4096:
            raise Invalid()
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise Invalid()
    elif not (value is None or isinstance(value, (bool, int))):
        raise Invalid()

def scalar(value):
    return value is None or isinstance(value, (str, bool, int, Decimal))

def required_string(record, key, limit=None, nonempty=False):
    value = record.get(key)
    if not isinstance(value, str) or (nonempty and not value):
        raise Invalid()
    bound = limit if limit is not None else (512 if key in SMALL_FIELDS else 4096)
    if byte_len(value) > bound:
        raise Invalid()
    return value

def source_path(record, tracked):
    value = required_string(record, "source_file", 1024, True)
    if ("\0" in value or "\\" in value or value.startswith("/") or
            re.match(r"^[A-Za-z]:", value)):
        raise Invalid()
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or value not in tracked:
        raise Invalid()

def location(record):
    value = required_string(record, "source_location", 32, True)
    if not LOCATION.fullmatch(value):
        raise Invalid()

def unknown_scalars(record, known):
    for key, value in record.items():
        if key not in known and not scalar(value):
            raise Invalid()

def load_manifest(path, expected_hash):
    raw = open(path, "rb").read()
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise Invalid()
    if not raw:
        return set()
    if not raw.endswith(b"\0"):
        raise Invalid()
    decoded = raw[:-1].decode("utf-8").split("\0")
    if len(decoded) != len(set(decoded)):
        raise Invalid()
    return set(decoded)

def validate(raw, commit, tracked):
    if len(raw) > MAX_BYTES:
        raise Invalid()
    text = raw.decode("utf-8")
    root = json.loads(text, object_pairs_hook=pairs_hook, parse_float=number,
                      parse_int=integer, parse_constant=reject_constant)
    validate_tree(root)
    if not isinstance(root, ObjPairs):
        raise Invalid()
    data = to_dict(root)
    if set(data) != TOP_KEYS or data["directed"] is not False or data["multigraph"] is not False:
        raise Invalid()
    if not isinstance(data["graph"], ObjPairs):
        raise Invalid()
    graph = to_dict(data["graph"])
    unknown_scalars(graph, set())
    if not isinstance(data["built_at_commit"], str) or not COMMIT.fullmatch(data["built_at_commit"]):
        raise Invalid()
    if data["built_at_commit"] != commit:
        raise Invalid()
    nodes, links, hyperedges = data["nodes"], data["links"], data["hyperedges"]
    if not isinstance(nodes, list) or len(nodes) > 50000:
        raise Invalid()
    if not isinstance(links, list) or len(links) > 100000:
        raise Invalid()
    if not isinstance(hyperedges, list) or hyperedges:
        raise Invalid()
    ids = set()
    for raw_node in nodes:
        if not isinstance(raw_node, ObjPairs):
            raise Invalid()
        node = to_dict(raw_node)
        if not NODE_REQUIRED <= set(node):
            raise Invalid()
        for key in NODE_REQUIRED:
            required_string(node, key, nonempty=(key == "id"))
        node_id = node["id"]
        if node_id in ids:
            raise Invalid()
        ids.add(node_id)
        if "community" in node and (isinstance(node["community"], bool) or not isinstance(node["community"], int) or node["community"] < 0):
            raise Invalid()
        for key in ("_origin", "community_name", "norm_label"):
            if key in node:
                required_string(node, key)
        for key in ("_callable", "_callable_class"):
            if key in node and not isinstance(node[key], bool):
                raise Invalid()
        source_path(node, tracked)
        location(node)
        unknown_scalars(node, NODE_REQUIRED | NODE_OPTIONAL)
    for raw_link in links:
        if not isinstance(raw_link, ObjPairs):
            raise Invalid()
        link = to_dict(raw_link)
        if not (LINK_REQUIRED_STR | LINK_REQUIRED_NUM) <= set(link):
            raise Invalid()
        for key in LINK_REQUIRED_STR:
            required_string(link, key, nonempty=key in {"source", "target", "relation"})
        for key in LINK_REQUIRED_NUM:
            value = link[key]
            if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
                raise Invalid()
        if link["source"] not in ids or link["target"] not in ids:
            raise Invalid()
        if link["confidence"] not in {"EXTRACTED", "INFERRED", "AMBIGUOUS"}:
            raise Invalid()
        for key in LINK_OPTIONAL:
            if key in link:
                required_string(link, key)
        source_path(link, tracked)
        location(link)
        unknown_scalars(link, LINK_REQUIRED_STR | LINK_REQUIRED_NUM | LINK_OPTIONAL)
    return {"byteSize": len(raw), "contentChecksumSha256": hashlib.sha256(raw).hexdigest(),
            "nodeCount": len(nodes), "linkCount": len(links), "hyperedgeCount": len(hyperedges)}

def main():
    try:
        if len(sys.argv) != 4 or not COMMIT.fullmatch(sys.argv[1]):
            raise Invalid()
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        result = validate(raw, sys.argv[1], load_manifest(sys.argv[2], sys.argv[3]))
        encoded = json.dumps(result, separators=(",", ":"), sort_keys=True).encode("ascii")
        if len(encoded) > 4096:
            raise Invalid()
        sys.stdout.buffer.write(encoded)
    except Exception:
        sys.exit(2)

if __name__ == "__main__":
    main()
