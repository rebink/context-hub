import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  DEPLOYMENT_MANIFEST_SCHEMA,
  generatedManifestSchema,
} from "./deployment-contract.mjs";

const path = resolve(import.meta.dirname, "deployment-manifest.schema.json");
const expected = generatedManifestSchema();
if (process.argv[2] === "--write") {
  await writeFile(path, expected, "utf8");
  process.stdout.write(`${canonicalJson({ status: "PASS", action: "written" })}\n`);
} else if (process.argv[2] === "--check") {
  const actual = JSON.parse(await readFile(path, "utf8"));
  if (canonicalJson(actual) !== canonicalJson(DEPLOYMENT_MANIFEST_SCHEMA))
    throw new Error("GENERATED_SCHEMA_DRIFT");
  process.stdout.write(`${canonicalJson({ status: "PASS", action: "checked" })}\n`);
} else {
  throw new Error("USAGE:--check|--write");
}
