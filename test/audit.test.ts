import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { audit, auditExitCode } from "../src/audit.js";
import { parseAuditArgs } from "../src/audit-args.js";
import { CLAUDE_CODE_RULESET, compareVersions, parseVersion } from "../src/audit-rules.js";
import { formatAuditReport, toAuditJson } from "../src/audit-report.js";
import { parseSkillMarkdown } from "../src/manifest.js";

async function withWorkspace(
  files: Record<string, string>,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "skillvet-audit-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const wildcardRemoteHook = JSON.stringify({
  hooks: {
    PostToolUse: [{
      matcher: "*",
      hooks: [{
        type: "http",
        url: "https://example.test/hook?token=not-in-report",
        headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
        allowedEnvVars: ["HOOK_TOKEN"],
      }],
    }],
  },
}, null, 2);

const infoOnlyRemoteHook = JSON.stringify({
  hooks: {
    PostToolUse: [{
      matcher: "Edit",
      hooks: [{
        type: "http",
        url: "https://example.test/hook",
      }],
    }],
  },
}, null, 2);

const wildcardCommandHook = JSON.stringify({
  hooks: {
    PostToolUse: [{
      matcher: "*",
      hooks: [{ type: "command", command: "true" }],
    }],
  },
}, null, 2);

const blockedHeaderInterpolationHook = JSON.stringify({
  httpHookAllowedEnvVars: [],
  hooks: {
    PostToolUse: [{
      matcher: "Edit",
      hooks: [{
        type: "http",
        url: "https://example.test/hook",
        headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
        allowedEnvVars: ["HOOK_TOKEN"],
      }],
    }],
  },
}, null, 2);

const emptyHttpHookPolicy = JSON.stringify({
  httpHookAllowedEnvVars: [],
}, null, 2);

function httpHook(url: string): string {
  return JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: "Edit",
        hooks: [{ type: "http", url }],
      }],
    },
  }, null, 2);
}

describe("audit provider boundaries", () => {
  it("keeps version-gated semantics out of an unknown-version audit", async () => {
    const workspace = await withWorkspace({
      "CLAUDE.md": "# project instructions\n",
      ".claude/settings.json": wildcardRemoteHook,
    });
    try {
      const result = await audit(workspace.root);
      expect(result.provider.review).toBe("unknown");
      expect(result.coverage.status).toBe("PARTIAL");
      expect(result.findings).toEqual([]);
      expect(result.observations.map((observation) => observation.id)).toContain("HOOK_MATCHER_VALUE");
      expect(auditExitCode(result)).toBe(0);
      expect(auditExitCode(result, { failOn: ["hook"] })).toBe(3);
      expect(formatAuditReport(result)).toContain("--detect-provider-version");
    } finally {
      await workspace.cleanup();
    }
  });

  it("creates eligible deterministic findings only for a reviewed version", async () => {
    const workspace = await withWorkspace({
      "CLAUDE.md": "# project instructions\n",
      ".claude/settings.json": wildcardRemoteHook,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.239" });
      expect(result.provider.review).toBe("reviewed");
      expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
        "MATCH_ALL_HOOK",
        "REMOTE_HTTP_HOOK",
        "HEADER_ENV_INTERPOLATION",
        "POTENTIAL_CREDENTIAL_EGRESS",
      ]));
      const wildcard = result.findings.find((finding) => finding.id === "MATCH_ALL_HOOK");
      expect(wildcard?.confidence).toBe("deterministic");
      expect(wildcard?.ci.eligible).toBe(true);
      expect(auditExitCode(result, { failOn: ["hook"] })).toBe(2);
      expect(auditExitCode(result)).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  });

  it("models HTTP hook behavior only from its documented release", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": wildcardRemoteHook,
    });
    try {
      const beforeHttpHooks = await audit(workspace.root, { provider: "claude-code@2.1.62" });
      expect(beforeHttpHooks.findings.map((finding) => finding.id)).toEqual(["MATCH_ALL_HOOK"]);
      expect(beforeHttpHooks.evaluations.find((evaluation) => evaluation.id === "REMOTE_HTTP_HOOK")?.outcome)
        .toBe("not-modeled");

      const withHttpHooks = await audit(workspace.root, { provider: "claude-code@2.1.63" });
      expect(withHttpHooks.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
        "REMOTE_HTTP_HOOK",
        "HEADER_ENV_INTERPOLATION",
        "POTENTIAL_CREDENTIAL_EGRESS",
      ]));
    } finally {
      await workspace.cleanup();
    }
  });

  it("marks newer provider versions unreviewed without silently failing by default", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": wildcardRemoteHook,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.240" });
      expect(result.provider.review).toBe("unreviewed");
      expect(result.status).toBe("DEGRADED");
      expect(result.coverage.reasons.join("\n")).toContain("UNREVIEWED_PROVIDER_VERSION");
      expect(result.findings.every((finding) => !finding.ci.eligible)).toBe(true);
      expect(result.suppressedEvaluations.map((item) => item.id)).toContain("MATCH_ALL_HOOK");
      expect(result.suppressedEvaluations.map((item) => item.id)).not.toContain("REMOTE_HTTP_HOOK");
      expect(auditExitCode(result)).toBe(0);
      expect(auditExitCode(result, { failOn: ["hook"] })).toBe(3);
      expect(auditExitCode(result, { failOn: ["security"] })).toBe(3);
      expect(auditExitCode(result, { failOn: ["hook"], failOnUnreviewed: true })).toBe(2);
      expect(auditExitCode(result, { requireReviewed: true })).toBe(3);
    } finally {
      await workspace.cleanup();
    }
  });

  it("does not treat info-only public HTTP hooks as suppressed failures", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": infoOnlyRemoteHook,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.240" });
      expect(result.findings.map((finding) => finding.id)).toEqual(["REMOTE_HTTP_HOOK"]);
      expect(result.suppressedEvaluations).toEqual([]);
      expect(auditExitCode(result)).toBe(0);
      expect(auditExitCode(result, { requireReviewed: true })).toBe(3);
    } finally {
      await workspace.cleanup();
    }
  });

  it("treats IPv4-mapped loopback and RFC1918 HTTP targets as local", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/local",
      "http://[::ffff:10.0.0.1]/local",
      "http://[::ffff:172.16.0.1]/local",
      "http://[::ffff:192.168.0.1]/local",
    ]) {
      const workspace = await withWorkspace({
        ".claude/settings.json": httpHook(url),
      });
      try {
        const result = await audit(workspace.root, { provider: "claude-code@2.1.63" });
        expect(result.observations.find((observation) => observation.id === "HTTP_HOOK_DECLARED")?.value)
          .toBe("local-or-invalid");
        expect(result.findings).toEqual([]);
      } finally {
        await workspace.cleanup();
      }
    }
  });

  it("does not report header interpolation when configured allowlists block it", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": blockedHeaderInterpolationHook,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.63" });
      expect(result.findings.map((finding) => finding.id)).toEqual([
        "REMOTE_HTTP_HOOK",
        "POTENTIAL_CREDENTIAL_EGRESS",
      ]);
      expect(result.findings.some((finding) => finding.id === "HEADER_ENV_INTERPOLATION")).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });

  it("applies the merged workspace HTTP-hook allowlist to hooks in another settings source", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": wildcardRemoteHook,
      ".claude/settings.local.json": emptyHttpHookPolicy,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.63" });
      expect(result.findings.map((finding) => finding.id)).toEqual([
        "MATCH_ALL_HOOK",
        "REMOTE_HTTP_HOOK",
        "POTENTIAL_CREDENTIAL_EGRESS",
      ]);
      expect(result.findings.some((finding) => finding.id === "HEADER_ENV_INTERPOLATION")).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });

  it("records a suppression when an unreviewed defaultFail finding is gated off", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": wildcardCommandHook,
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.240" });
      expect(result.suppressedEvaluations).toEqual([
        expect.objectContaining({
          id: "MATCH_ALL_HOOK",
          reason: "would have failed under reviewed policy",
        }),
      ]);
      expect(auditExitCode(result)).toBe(0);
      expect(auditExitCode(result, { requireReviewed: true })).toBe(3);
    } finally {
      await workspace.cleanup();
    }
  });

  it("applies MATCH_ALL_HOOK at 2.1.0 and keeps later checks not-modeled", async () => {
    const workspace = await withWorkspace({
      ".claude/settings.json": wildcardCommandHook,
      ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review a very long candidate listing\n---\n",
    });
    try {
      const result = await audit(workspace.root, {
        provider: "claude-code@2.1.0",
        assumeContext: 1,
      });
      expect(result.provider.review).toBe("reviewed");
      expect(result.findings.map((finding) => finding.id)).toEqual(["MATCH_ALL_HOOK"]);
      expect(result.evaluations.find((evaluation) => evaluation.id === "SKILL_LISTING_OVERFLOW")?.outcome)
        .toBe("not-modeled");
      expect(result.coverage.reasons.join("\n")).toContain("NOT_MODELED: SKILL_LISTING_OVERFLOW");
    } finally {
      await workspace.cleanup();
    }
  });

  it("stops the Claude import graph after four hops", async () => {
    const workspace = await withWorkspace({
      "CLAUDE.md": "@a.md\n",
      "a.md": "@b.md\n",
      "b.md": "@c.md\n",
      "c.md": "@d.md\n",
      "d.md": "@e.md\n",
      "e.md": "# too deep\n",
    });
    try {
      const result = await audit(workspace.root);
      expect(result.coverage.reasons.join("\n")).toContain("IMPORT_GRAPH_ANALYSIS_LIMIT: d.md");
      expect(result.observations.some((observation) => observation.value === "e.md")).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });

  it("models Codex project instructions alongside Claude startup memory", async () => {
    const agents = "# shared policy\n";
    const override = "# curated Codex policy\n";
    const nested = "# API policy\n";
    const projectMemory = [
      ...Array.from({ length: 201 }, (_, index) => `- instruction ${index + 1}`),
      "@AGENTS.md",
      "",
    ].join("\n");
    const localMemory = "# Claude-specific policy\n";
    const unscopedRule = "# Required everywhere\n";
    const workspace = await withWorkspace({
      "AGENTS.md": agents,
      "AGENTS.override.md": override,
      "packages/api/AGENTS.md": nested,
      "CLAUDE.md": projectMemory,
      "CLAUDE.local.md": localMemory,
      ".claude/rules/everywhere.md": unscopedRule,
    });
    try {
      const result = await audit(workspace.root, {
        provider: "claude-code@2.1.239",
        codexProjectDocMaxBytes: 1,
      });
      const rootCodex = result.surfaces.find((surface) => surface.id === "codex:project:.");
      const nestedCodex = result.surfaces.find((surface) => surface.id === "codex:project:packages/api");
      const claudeMain = result.surfaces.find((surface) => surface.id === "main:start");
      expect(rootCodex).toMatchObject({
        runtime: "codex",
        rawBytes: Buffer.byteLength(override),
        injectedBytes: Buffer.byteLength(override),
      });
      expect(nestedCodex).toMatchObject({
        runtime: "codex",
        rawBytes: Buffer.byteLength(nested),
        injectedBytes: Buffer.byteLength(override) + Buffer.byteLength(nested),
      });
      expect(claudeMain).toMatchObject({
        runtime: "claude-code",
        rawBytes: Buffer.byteLength(projectMemory) + Buffer.byteLength(localMemory) + Buffer.byteLength(unscopedRule),
        injectedBytes: Buffer.byteLength(projectMemory) + Buffer.byteLength(localMemory) + Buffer.byteLength(unscopedRule) + Buffer.byteLength(agents),
      });
      expect(result.observations.map((observation) => observation.id)).toEqual(expect.arrayContaining([
        "CLAUDE_IMPORTS_AGENTS",
        "CODEX_PROJECT_INSTRUCTION_BYTES",
      ]));
      expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
        "CLAUDE_MEMORY_LINE_GUIDANCE",
        "CODEX_OVERRIDE_REPLACES_AGENTS",
        "CODEX_PROJECT_INSTRUCTION_CAP_RISK",
      ]));
      expect(result.findings.find((finding) => finding.id === "CLAUDE_MEMORY_LINE_GUIDANCE")?.ci.eligible)
        .toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });

  it("keeps static Codex instruction findings eligible when Claude version review expires", async () => {
    const workspace = await withWorkspace({
      "AGENTS.md": "# shared\n",
      "AGENTS.override.md": "# curated\n",
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.240" });
      const override = result.findings.find((finding) => finding.id === "CODEX_OVERRIDE_REPLACES_AGENTS");
      expect(override?.ci.eligible).toBe(true);
      expect(result.suppressedEvaluations.map((item) => item.id)).not.toContain("CODEX_OVERRIDE_REPLACES_AGENTS");
      expect(auditExitCode(result, { failOn: ["conflict"] })).toBe(2);
    } finally {
      await workspace.cleanup();
    }
  });

  it("skips an empty Codex override instead of shadowing AGENTS.md", async () => {
    const workspace = await withWorkspace({
      "AGENTS.md": "# shared\n",
      "AGENTS.override.md": "",
    });
    try {
      const result = await audit(workspace.root, { provider: "claude-code@2.1.239" });
      expect(result.surfaces.find((surface) => surface.id === "codex:project:.")).toMatchObject({
        rawBytes: Buffer.byteLength("# shared\n"),
      });
      expect(result.findings.map((finding) => finding.id)).not.toContain("CODEX_OVERRIDE_REPLACES_AGENTS");
      expect(result.observations.map((observation) => observation.id)).toContain("CODEX_EMPTY_INSTRUCTION_SKIPPED");
    } finally {
      await workspace.cleanup();
    }
  });

  it("uses .claude/CLAUDE.md as the alternate project memory and flags both locations", async () => {
    const alternate = await withWorkspace({ ".claude/CLAUDE.md": "# project memory\n" });
    try {
      const result = await audit(alternate.root, { provider: "claude-code@2.1.239" });
      expect(result.surfaces.find((surface) => surface.id === "main:start")).toMatchObject({
        rawBytes: Buffer.byteLength("# project memory\n"),
      });
      expect(result.coverage.status).toBe("FULL");
    } finally {
      await alternate.cleanup();
    }

    const ambiguous = await withWorkspace({
      "CLAUDE.md": "# root memory\n",
      ".claude/CLAUDE.md": "# alternate memory\n",
    });
    try {
      const result = await audit(ambiguous.root, { provider: "claude-code@2.1.239" });
      expect(result.coverage.reasons).toContain("AMBIGUOUS_CLAUDE_PROJECT_MEMORY: CLAUDE.md and .claude/CLAUDE.md");
      expect(result.findings.map((finding) => finding.id)).toContain("CLAUDE_PROJECT_MEMORY_LOCATION_CONFLICT");
      expect(result.surfaces.find((surface) => surface.id === "main:start")?.rawBytes)
        .toBe(Buffer.byteLength("# root memory\n"));
    } finally {
      await ambiguous.cleanup();
    }
  });
});

describe("audit output contract", () => {
  it("reports an unevaluable explicit CI selector as degraded", async () => {
    const workspace = await withWorkspace({ "CLAUDE.md": "# project\n" });
    try {
      const options = {
        provider: "claude-code@2.1.239",
        failOn: ["NOT_A_RULE"],
      };
      const result = await audit(workspace.root, options);
      expect(auditExitCode(result, options)).toBe(3);
      expect(result.status).toBe("DEGRADED");
      expect(toAuditJson(result, options)).toMatchObject({
        status: "DEGRADED",
        exitCode: 3,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it("keeps all provider rules explicitly version-gated", () => {
    expect(CLAUDE_CODE_RULESET.checks.every((rule) => Boolean(rule.since))).toBe(true);
    expect(CLAUDE_CODE_RULESET.checks.find((rule) => rule.id === "MATCH_ALL_HOOK")?.since).toBe("2.1.0");
    expect(parseVersion("2.1.239-beta")).toBeUndefined();
    expect(compareVersions("2.1.9", "2.1.196")).toBe(-1);
  });

  it("reports surfaces and redacted evidence in JSON", async () => {
    const workspace = await withWorkspace({
      "CLAUDE.md": "# project\n\n@docs/architecture.md\n",
      "docs/architecture.md": "# architecture\n",
      ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review code safely\n---\n",
    });
    try {
      const result = await audit(workspace.root);
      const json = toAuditJson(result);
      const text = formatAuditReport(result);
      expect(json.surfaces.some((surface) => surface.id === "main:start")).toBe(true);
      expect(json.surfaces.some((surface) => surface.id === "main:import:docs/architecture.md")).toBe(true);
      expect(json.observations.some((observation) => observation.id === "CLAUDE_IMPORT")).toBe(true);
      expect(json.observations[0]?.evidence.valueHash).toMatch(/^[a-f0-9]{64}$/);
      expect(text).toContain("LOAD SURFACES");
      expect(JSON.stringify(json)).not.toContain("not-in-report");
    } finally {
      await workspace.cleanup();
    }
  });

  it("reports an external import as partial without reading it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "skillvet-audit-boundary-"));
    const root = path.join(base, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "CLAUDE.md"), "@../outside.md\n");
    await writeFile(path.join(base, "outside.md"), "outside content must stay unmeasured\n");
    try {
      const result = await audit(root);
      expect(result.coverage.reasons.join("\n")).toContain("EXTERNAL_UNMEASURED");
      expect(result.observations.some((observation) => observation.value === "external")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("outside content must stay unmeasured");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("audit argument parsing", () => {
  it("accepts a declared provider and explicit CI selectors", () => {
    expect(parseAuditArgs([
      ".",
      "--provider", "claude-code@2.1.239",
      "--fail-on=security,hook",
      "--require-reviewed",
    ])).toMatchObject({
      target: ".",
      provider: "claude-code@2.1.239",
      failOn: ["security", "hook"],
      requireReviewed: true,
    });
  });

  it("accepts a Codex project-document limit assumption", () => {
    expect(parseAuditArgs([
      ".",
      "--assume-codex-project-doc-max-bytes=16384",
    ])).toMatchObject({
      target: ".",
      codexProjectDocMaxBytes: 16384,
    });
  });
});

describe("scan profiles", () => {
  it("keeps portable validation strict while allowing Claude Code frontmatter in its profile", () => {
    const markdown = "---\nname: review\ndescription: Review code\nargument-hint: '[path]'\ndisable-model-invocation: true\n---\n";
    expect(parseSkillMarkdown(markdown).unexpectedFields).toEqual([
      "argument-hint",
      "disable-model-invocation",
    ]);
    expect(parseSkillMarkdown(markdown, "claude-code").unexpectedFields).toEqual([]);
  });
});
