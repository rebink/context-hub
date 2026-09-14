import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { METRICS, type MetricDefinition } from "./metrics-registry.mts";

export const REGISTRY_START = "<!-- METRICS_REGISTRY_START -->";
export const REGISTRY_END = "<!-- METRICS_REGISTRY_END -->";

function cell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function dimensions(metric: MetricDefinition) {
  return metric.dimensions
    .map((dimension) => `${dimension.key}={${dimension.values.join(",")}}`)
    .join("; ");
}

export function renderMetricRegistry(metrics: readonly MetricDefinition[] = METRICS) {
  const header =
    "| ID | Name | Formula | Numerator | Denominator | Unit | Window | Inclusion | Exclusion | Source | Privacy | Dimension allowlist | Retention | Collection | Baseline | Target | Threshold | Cadence | Owner | Status | Requirement sources |";
  const separator = `|${Array.from({ length: 21 }, () => " --- ").join("|")}|`;
  const rows = metrics.map((metric) =>
    [
      metric.id,
      metric.name,
      metric.formula,
      metric.numerator,
      metric.denominator,
      metric.unit,
      metric.window,
      metric.inclusion,
      metric.exclusion,
      metric.source,
      metric.privacy,
      dimensions(metric),
      metric.retention,
      metric.collection,
      metric.baseline,
      metric.target,
      metric.threshold,
      metric.cadence,
      metric.owner,
      metric.status,
      metric.requirementSources.join("; "),
    ]
      .map(cell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
  return [REGISTRY_START, header, separator, ...rows, REGISTRY_END].join("\n");
}

export function replaceMetricRegistry(
  markdown: string,
  metrics: readonly MetricDefinition[] = METRICS,
) {
  const start = markdown.indexOf(REGISTRY_START);
  const end = markdown.indexOf(REGISTRY_END);
  assert.ok(start >= 0 && end > start, "metrics registry markers missing or reversed");
  assert.equal(markdown.indexOf(REGISTRY_START, start + 1), -1, "duplicate registry start marker");
  assert.equal(markdown.indexOf(REGISTRY_END, end + 1), -1, "duplicate registry end marker");
  return `${markdown.slice(0, start)}${renderMetricRegistry(metrics)}${markdown.slice(end + REGISTRY_END.length)}`;
}

export function checkMetricDocs(markdown: string, metrics: readonly MetricDefinition[] = METRICS) {
  assert.equal(
    markdown,
    replaceMetricRegistry(markdown, metrics),
    "docs metric registry differs from canonical registry; run npm run metrics:docs",
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const path = new URL("../docs/ai/metrics.md", import.meta.url);
  const markdown = await readFile(path, "utf8");
  if (process.argv.includes("--write")) {
    await writeFile(path, replaceMetricRegistry(markdown));
    console.log("metrics docs registry generated");
  } else {
    checkMetricDocs(markdown);
    console.log("metrics docs registry check passed");
  }
}
