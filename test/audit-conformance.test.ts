import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { auditCodex } from "../src/codex-audit.js";
import { fixture } from "./helpers.js";

interface VersionBoundaryExpectation {
  expected: "NOT_MODELED";
  ruleId: string;
  provider: string;
  notImplemented: Array<{
    axis: string;
    fixturePath: string;
    expected: "NOT_IMPLEMENTED";
  }>;
}

describe("loader-semantic conformance corpus", () => {
  it("models the Codex override winner and inherited instruction bytes", async () => {
    const root = fixture("conformance/codex-override-chain");
    const result = await audit(root, { provider: "claude-code@2.1.239" });

    expect(result.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex:project:.",
        rawBytes: Buffer.byteLength("# curated root policy\n"),
        injectedBytes: Buffer.byteLength("# curated root policy\n"),
      }),
      expect.objectContaining({
        id: "codex:project:packages/api",
        rawBytes: Buffer.byteLength("# API policy\n"),
        injectedBytes: Buffer.byteLength("# curated root policy\n# API policy\n"),
      }),
    ]));
    expect(result.findings.map((finding) => finding.id)).toContain("CODEX_OVERRIDE_REPLACES_AGENTS");
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "CODEX_PROJECT_INSTRUCTION_BYTES",
        value: Buffer.byteLength("# curated root policy\n# API policy\n"),
      }),
    ]));
  });

  it("applies a selected Codex profile before resolving skills.config enabled state", async () => {
    const result = await auditCodex(fixture("conformance/codex-profile-skills"), { profile: "lean" });

    expect(result.profile).toEqual(expect.objectContaining({
      name: "lean",
      configPath: expect.stringMatching(/lean\.config\.toml$/),
    }));
    expect(result.catalogue).toMatchObject({ discovered: 3, enabled: 2, disabled: 1 });
    expect(result.skills.map((skill) => [skill.name, skill.enabled])).toEqual([
      ["disabled", false],
      ["review", true],
      ["unconfigured", true],
    ]);
    expect(result.findings.map((finding) => finding.id)).not.toContain("CONFLICTING_SKILL_OVERRIDE");
  });

  it("keeps Claude imports, memory ambiguity, and version boundaries distinct", async () => {
    const root = fixture("conformance/claude-import-version");
    const expectation = JSON.parse(
      await readFile(fixture("conformance/claude-import-version/expectations.json"), "utf8"),
    ) as VersionBoundaryExpectation;

    const reviewed = await audit(root, { provider: "claude-code@2.1.239" });
    expect(reviewed.coverage.reasons).toContain(
      "AMBIGUOUS_CLAUDE_PROJECT_MEMORY: CLAUDE.md and .claude/CLAUDE.md",
    );
    expect(reviewed.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "main:import:AGENTS.md", runtime: "claude-code" }),
    ]));
    expect(reviewed.observations.map((observation) => observation.id)).toEqual(expect.arrayContaining([
      "CLAUDE_IMPORTS_AGENTS",
    ]));
    expect(reviewed.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
      "CLAUDE_PROJECT_MEMORY_LOCATION_CONFLICT",
      "MATCH_ALL_HOOK",
    ]));

    const unsupported = await audit(root, {
      provider: expectation.provider,
      assumeContext: 1,
    });
    expect(unsupported.evaluations.find((item) => item.id === expectation.ruleId)).toMatchObject({
      evaluated: false,
      outcome: "not-modeled",
    });
    expect(unsupported.coverage.reasons).toContain(
      `NOT_MODELED: ${expectation.ruleId} is outside its version window`,
    );

    const unreviewed = await audit(root, { provider: "claude-code@2.1.240" });
    expect(unreviewed.provider.review).toBe("unreviewed");
    expect(unreviewed.coverage.reasons.join("\n")).toContain("UNREVIEWED_PROVIDER_VERSION");
    expect(unreviewed.findings.find((finding) => finding.id === "MATCH_ALL_HOOK")?.ci.eligible).toBe(false);

    for (const blindSpot of expectation.notImplemented) {
      expect(blindSpot.axis).toBe("prompt-injection");
      expect(blindSpot.expected).toBe("NOT_IMPLEMENTED");
      expect(await readFile(path.join(root, blindSpot.fixturePath), "utf8"))
        .toContain("Ignore prior instructions");
      expect(reviewed.findings.map((finding) => finding.id)).not.toContain("PI-OVERRIDE");
      expect(reviewed.evaluations.map((evaluation) => evaluation.id)).not.toContain("PI-OVERRIDE");
      expect(JSON.stringify(reviewed)).not.toContain("Ignore prior instructions");
    }
  });
});
