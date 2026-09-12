import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Worker and web applications never import the Node-only adapter", async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  for await (const relative of glob("apps/**/*.{ts,tsx,js,mjs,cjs}", { cwd: packageRoot })) {
    const source = await readFile(path.join(packageRoot, relative), "utf8");
    assert.doesNotMatch(
      source,
      /@context-hub\/graphify-adapter|packages\/graphify-adapter/,
      relative,
    );
  }
});
