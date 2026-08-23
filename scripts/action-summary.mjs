import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_SCHEMA_VERSION = 1;

export function parseAuditReport(content) {
  const report = JSON.parse(content);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("skillvet action expected a JSON object report");
  }
  if (report.schemaVersion !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(`skillvet action requires audit JSON schema ${REQUIRED_SCHEMA_VERSION}`);
  }
  for (const key of ["toolVersion", "status", "exitCode", "coverage", "findings", "rulesetIds"]) {
    if (!(key in report)) throw new Error(`skillvet action report is missing ${key}`);
  }
  if (!Array.isArray(report.findings) || !Array.isArray(report.rulesetIds)) {
    throw new Error("skillvet action report has invalid findings or rulesetIds");
  }
  return report;
}

export function renderSummary(report) {
  const coverage = report.coverage && typeof report.coverage === "object"
    ? String(report.coverage.status ?? "unknown")
    : "unknown";
  const rulesetIds = report.rulesetIds.length === 0
    ? "none"
    : report.rulesetIds.map(markdownCode).join(", ");
  return [
    "### skillvet audit",
    "",
    `- Status: ${markdownCode(report.status)}`,
    `- Coverage: ${markdownCode(coverage)}`,
    `- Schema: ${markdownCode(report.schemaVersion)}`,
    `- Tool: ${markdownCode(report.toolVersion)}`,
    `- Rulesets: ${rulesetIds}`,
    `- Findings: ${markdownCode(report.findings.length)}`,
    "",
  ].join("\n");
}

export function outputLines(report, reportPath) {
  return [
    ["report-path", reportPath],
    ["schema-version", String(report.schemaVersion)],
    ["tool-version", String(report.toolVersion)],
    ["status", String(report.status)],
    ["exit-code", String(report.exitCode)],
    ["finding-count", String(report.findings.length)],
  ].map(([key, value]) => `${key}=${safeOutputValue(value)}`);
}

async function main(argv, environment) {
  const reportPath = argv[0];
  if (!reportPath) throw new Error("usage: action-summary.mjs <audit-json-path>");
  const report = parseAuditReport(await readFile(reportPath, "utf8"));
  const summary = renderSummary(report);
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(environment.GITHUB_STEP_SUMMARY, summary, "utf8");
  } else {
    process.stdout.write(summary);
  }
  if (environment.GITHUB_OUTPUT) {
    await appendFile(environment.GITHUB_OUTPUT, `${outputLines(report, reportPath).join("\n")}\n`, "utf8");
  }
}

function markdownCode(value) {
  return `\`${String(value).replace(/`/g, "\\`")}\``;
}

function safeOutputValue(value) {
  if (/\r|\n/.test(value)) throw new Error("skillvet action output contains a newline");
  return value;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main(process.argv.slice(2), process.env).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
