import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import {
  AUDIT_FINDING_ID_POLICY,
  AUDIT_JSON_SCHEMA_VERSION,
  auditFindingIdStatuses,
  auditRulesetIds,
} from "../src/audit-contract.js";
import { toAuditJson } from "../src/audit-report.js";
import { fixture } from "./helpers.js";

const canonicalWorkspace = fixture("audit-contract/workspace");
const canonicalOutput = fixture("audit-contract/canonical-output.json");

describe("audit JSON contract v1", () => {
  it("separates schema and tool versions and exposes stable finding-ID policy", async () => {
    const result = await audit(canonicalWorkspace, { provider: "claude-code@2.1.239" });
    const json = toAuditJson(result);

    expect(json).toMatchObject({
      schemaVersion: AUDIT_JSON_SCHEMA_VERSION,
      toolVersion: result.version,
      findingIdPolicy: AUDIT_FINDING_ID_POLICY,
    });
    expect(json).not.toHaveProperty("version");
    expect(json.rulesetIds).toEqual([
      "claude-code/docs-2026-08-22",
      "workspace-instructions/docs-2026-08-23",
    ]);
    expect(json.findingIdStatuses).toEqual(auditFindingIdStatuses());
    expect(json.findingIdStatuses.map((entry) => entry.id)).toEqual([
      ...json.findingIdStatuses.map((entry) => entry.id),
    ].sort((left, right) => left.localeCompare(right)));
  });

  it("does not claim a provider behavior ruleset when provider version is unknown", async () => {
    const result = await audit(canonicalWorkspace);
    expect(auditRulesetIds(result.provider)).toEqual([
      "workspace-instructions/docs-2026-08-23",
    ]);
    expect(toAuditJson(result).rulesetIds).toEqual([
      "workspace-instructions/docs-2026-08-23",
    ]);
  });

  it("matches the canonical JSON fixture byte-for-byte after target normalization", async () => {
    const result = await audit(canonicalWorkspace, { provider: "claude-code@2.1.239" });
    const report = toAuditJson(result);
    const canonical = { ...report, target: "<FIXTURE_ROOT>" };
    const expected = await readFile(canonicalOutput, "utf8");

    expect(`${JSON.stringify(canonical, null, 2)}\n`).toBe(expected);
  });
});
