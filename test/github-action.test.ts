import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const actionPath = path.join(projectRoot, "action.yml");
const summaryPath = path.join(projectRoot, "scripts", "action-summary.mjs");

describe("GitHub Action", () => {
  it("runs audit JSON as a thin versioned-contract consumer", async () => {
    const action = parse(await readFile(actionPath, "utf8"));
    const auditStep = action.runs.steps.find((step: { id?: string }) => step.id === "audit");

    expect(action).toMatchObject({
      name: "Skillvet audit",
      runs: { using: "composite" },
      inputs: {
        target: { default: "." },
        "fail-on": { default: "security" },
        "require-reviewed": { default: "true" },
      },
      outputs: expect.objectContaining({
        "schema-version": expect.any(Object),
        "tool-version": expect.any(Object),
        "report-path": expect.any(Object),
      }),
    });
    expect(auditStep.run).toContain("path.resolve(process.env.GITHUB_WORKSPACE");
    expect(auditStep.run).toContain('tsx src/cli.ts "${args[@]}" > "$report_path"');
    expect(auditStep.run).toContain("--json");
  });

  it("renders only contract metadata in the job summary", async () => {
    const { outputLines, parseAuditReport, renderSummary } = await import(summaryPath);
    const report = parseAuditReport(JSON.stringify({
      schemaVersion: 1,
      toolVersion: "0.2.0",
      status: "DEGRADED",
      exitCode: 3,
      coverage: { status: "PARTIAL", reasons: ["fixture"] },
      rulesetIds: ["workspace-instructions/docs-2026-08-23"],
      findings: [{ id: "EXAMPLE" }],
    }));

    expect(renderSummary(report)).toContain("### skillvet audit");
    expect(renderSummary(report)).toContain("`workspace-instructions/docs-2026-08-23`");
    expect(outputLines(report, "/tmp/report.json")).toEqual(expect.arrayContaining([
      "schema-version=1",
      "finding-count=1",
    ]));
    expect(() => parseAuditReport(JSON.stringify({ schemaVersion: 2 }))).toThrow(
      "requires audit JSON schema 1",
    );
  });
});
