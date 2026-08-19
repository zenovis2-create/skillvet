import type { CheckResult, Finding, ScanContext } from "../types.js";

export function checkManifest(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const hasSkillFile = Boolean(ctx.skill);
  const hasMcp = Boolean(ctx.mcp);

  if (!hasSkillFile && !hasMcp) {
    findings.push({
      check: "manifest",
      message: "no SKILL.md or MCP manifest (server.json / mcp.json / package.json entry)",
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
      if (!isValidSkillName(ctx.skill.name)) {
        findings.push({
          check: "manifest",
          message: "SKILL.md frontmatter has an invalid name",
          file: "SKILL.md",
          score: 20,
        });
      }
      if (!isValidSkillDescription(ctx.skill.description)) {
        findings.push({
          check: "manifest",
          message: "SKILL.md frontmatter has an invalid description",
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

function isValidSkillName(name: string | undefined): boolean {
  return Boolean(name && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name));
}

function isValidSkillDescription(description: string | undefined): boolean {
  return Boolean(description && description.length <= 1024);
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
  const exact = findings.map((finding, index) => {
    const score = (finding.score * max) / total;
    return { index, floor: Math.floor(score), fraction: score - Math.floor(score) };
  });
  const remainder = max - exact.reduce((sum, item) => sum + item.floor, 0);
  const order = [...exact].sort(
    (a, b) => b.fraction - a.fraction || a.index - b.index,
  );
  const bonuses = new Set(order.slice(0, remainder).map((item) => item.index));
  const scaled = findings.map((finding, index) => ({
    ...finding,
    score: exact[index]!.floor + (bonuses.has(index) ? 1 : 0),
  }));
  return {
    id,
    title,
    score: scaled.reduce((a, f) => a + f.score, 0),
    findings: scaled,
  };
}
