import type { CheckResult, Finding, ScanContext } from "../types.js";

export function checkManifest(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const hasSkillFile = Boolean(ctx.skill);
  const hasMcp = Boolean(ctx.mcp);

  if (!hasSkillFile && !hasMcp) {
    findings.push({
      check: "manifest",
      message: "no SKILL.md or MCP manifest (mcp.json / package.json mcp entry)",
      score: 40,
    });
  }

  if (hasSkillFile) {
    if (!ctx.skill?.rawFrontmatter) {
      findings.push({
        check: "manifest",
        message: "SKILL.md is missing YAML frontmatter",
        file: "SKILL.md",
        score: 40,
      });
    } else {
      if (!ctx.skill.name) {
        findings.push({
          check: "manifest",
          message: "SKILL.md frontmatter is missing name",
          file: "SKILL.md",
          score: 20,
        });
      }
      if (!ctx.skill.description) {
        findings.push({
          check: "manifest",
          message: "SKILL.md frontmatter is missing description",
          file: "SKILL.md",
          score: 20,
        });
      }
    }
  }

  if (ctx.mcp && !ctx.mcp.valid) {
    findings.push({
      check: "manifest",
      message: `${ctx.mcp.source ?? "mcp.json"} is not a valid MCP server entry`,
      file: ctx.mcp.source,
      score: 40,
    });
  }

  return finish("manifest", "manifest", findings, 40);
}

export function finish(
  id: string,
  title: string,
  findings: Finding[],
  max: number,
): CheckResult {
  const total = findings.reduce((a, f) => a + f.score, 0);
  if (total <= max) {
    return { id, title, score: total, findings };
  }
  const scale = max / total;
  const scaled = findings.map((f) => ({
    ...f,
    score: Math.max(1, Math.round(f.score * scale)),
  }));
  return {
    id,
    title,
    score: Math.min(max, scaled.reduce((a, f) => a + f.score, 0)),
    findings: scaled,
  };
}
