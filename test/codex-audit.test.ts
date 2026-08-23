import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditCodex, codexAuditExitCode } from "../src/codex-audit.js";
import { parseCodexAuditArgs } from "../src/codex-audit-args.js";
import { formatCodexAuditReport, toCodexAuditJson } from "../src/codex-audit-report.js";

async function withCodexHome(
  config: string,
  skills: Record<string, string>,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "skillvet-codex-audit-"));
  await writeFile(path.join(root, "config.toml"), config);
  for (const [name, manifest] of Object.entries(skills)) {
    const directory = path.join(root, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), manifest);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("Codex home audit", () => {
  it("reads relevant config surfaces and reports a disabled catalogue accurately", async () => {
    const home = await withCodexHome(
      `[mcp_servers.local]
url = "http://127.0.0.1:8090/mcp"

[mcp_servers.remote]
url = "https://mcp.example.test/api?token=not-in-report"

[plugins."disabled@marketplace"]
enabled = false

[plugins."disabled@marketplace".mcp_servers.helper]
enabled = true

[hooks.state."disabled@marketplace:hooks/example.json:stop:0:0"]
trusted_hash = "sha256:example"

[[skills.config]]
path = "skills/disabled/SKILL.md"
enabled = false

[[skills.config]]
path = "missing/SKILL.md"
enabled = false
`,
      {
        active: "---\nname: active\ndescription: Active skill description.\n---\n",
        disabled: "---\nname: disabled\ndescription: Disabled skill description.\n---\n",
      },
    );
    try {
      const result = await auditCodex(home.root);
      expect(result.coverage).toEqual({ status: "FULL", reasons: [] });
      expect(result.catalogue).toMatchObject({
        discovered: 2,
        enabled: 1,
        disabled: 1,
        links: 0,
      });
      expect(result.skills.map((skill) => [skill.name, skill.enabled])).toEqual([
        ["active", true],
        ["disabled", false],
      ]);
      expect(result.mcpServers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "local", transport: "url", endpointScope: "local" }),
        expect.objectContaining({ name: "remote", transport: "url", endpointScope: "public" }),
      ]));
      expect(result.plugins).toEqual([
        expect.objectContaining({
          id: "disabled@marketplace",
          enabled: false,
          childSettings: 1,
          trustedHookStates: 1,
        }),
      ]);
      expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
        "PUBLIC_MCP_ENDPOINT",
        "INACTIVE_PLUGIN_CONFIGURATION",
        "UNRESOLVED_SKILL_OVERRIDE",
      ]));
      expect(result.status).toBe("FAIL");
      expect(codexAuditExitCode(result)).toBe(2);
      const json = JSON.stringify(toCodexAuditJson(result));
      expect(json).not.toContain("token=not-in-report");
      expect(toCodexAuditJson(result).exitCode).toBe(2);
      expect(formatCodexAuditReport(result)).toContain("CATALOGUE");
    } finally {
      await home.cleanup();
    }
  });

  it("flags conflicting override states without guessing which one wins", async () => {
    const home = await withCodexHome(
      `[[skills.config]]
path = "skills/review/SKILL.md"
enabled = false

[[skills.config]]
path = "skills/review/SKILL.md"
enabled = true
`,
      { review: "---\nname: review\ndescription: Review code.\n---\n" },
    );
    try {
      const result = await auditCodex(home.root);
      expect(result.findings.map((finding) => finding.id)).toContain("CONFLICTING_SKILL_OVERRIDE");
      expect(result.skills).toEqual([expect.objectContaining({ name: "review", enabled: true })]);
    } finally {
      await home.cleanup();
    }
  });

  it("layers a selected Codex profile before measuring the catalogue", async () => {
    const home = await withCodexHome(
      "[mcp_servers.local]\ncommand = \"local-mcp\"\n",
      {
        active: "---\nname: active\ndescription: Active skill.\n---\n",
        disabled: "---\nname: disabled\ndescription: Disabled skill.\n---\n",
      },
    );
    await writeFile(
      path.join(home.root, "lean.config.toml"),
      "[[skills.config]]\npath = \"skills/disabled/SKILL.md\"\nenabled = false\n",
    );
    try {
      const result = await auditCodex(home.root, { profile: "lean" });
      expect(result.profile).toMatchObject({ name: "lean" });
      expect(result.catalogue).toMatchObject({ discovered: 2, enabled: 1, disabled: 1 });
      expect(result.status).toBe("PASS");
      expect(codexAuditExitCode(result)).toBe(0);
      expect(result.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "disabled", enabled: false }),
      ]));
    } finally {
      await home.cleanup();
    }
  });

  it("degrades when a modeled Codex surface cannot be read", async () => {
    const home = await withCodexHome("", {});
    try {
      const result = await auditCodex(home.root);
      expect(result.coverage.status).toBe("PARTIAL");
      expect(result.coverage.reasons).toContain("UNREADABLE_SKILLS_DIRECTORY: skills");
      expect(result.status).toBe("DEGRADED");
      expect(codexAuditExitCode(result)).toBe(3);
    } finally {
      await home.cleanup();
    }
  });

  it("parses the dedicated Codex audit arguments", () => {
    expect(parseCodexAuditArgs(["C:/codex", "--json", "--no-color", "--profile", "lean"])).toMatchObject({
      target: "C:/codex",
      json: true,
      noColor: true,
      profile: "lean",
    });
  });
});
