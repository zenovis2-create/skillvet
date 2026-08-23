import { codexAuditExitCode } from "./codex-audit.js";
import { VERSION, type CodexAuditResult } from "./types.js";
import { redactUrls } from "./walk.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

export interface CodexAuditReportOptions {
  json?: boolean;
  color?: boolean;
}

export function formatCodexAuditReport(
  result: CodexAuditResult,
  options: CodexAuditReportOptions = {},
): string {
  if (options.json) return JSON.stringify(toCodexAuditJson(result), null, 2);
  const color = options.color ?? false;
  const paint = (code: string, value: string) => color ? `${code}${value}${RESET}` : value;
  const lines: string[] = [];
  lines.push(`${paint(BOLD, "skillvet")} ${VERSION}   audit codex  ${redactUrls(result.target)}`);
  lines.push(`coverage  ${status(result.coverage.status, color)}${result.coverage.reasons.length ? `  ${result.coverage.reasons.length} limitation(s)` : ""}`);
  for (const reason of result.coverage.reasons) lines.push(`  - ${redactUrls(reason)}`);
  lines.push("");
  lines.push("CATALOGUE");
  lines.push(`  ${result.catalogue.discovered} discovered  ${result.catalogue.enabled} enabled  ${result.catalogue.disabled} disabled  ${result.catalogue.links} links`);
  lines.push(`  discovery metadata  ${result.catalogue.listingBytes} B (not a token estimate)`);
  lines.push("");
  lines.push("MCP SERVERS");
  if (result.mcpServers.length === 0) lines.push("  none");
  for (const server of result.mcpServers) {
    lines.push(`  ${server.name}  ${server.transport}  ${server.endpointScope}`);
  }
  lines.push("");
  lines.push("PLUGINS");
  if (result.plugins.length === 0) lines.push("  none");
  for (const plugin of result.plugins) {
    lines.push(`  ${plugin.id}  enabled=${plugin.enabled}  child-settings=${plugin.childSettings}  trusted-hooks=${plugin.trustedHookStates}`);
  }
  lines.push("");
  lines.push("GLOBAL INSTRUCTIONS");
  if (!result.instructions.global.agents && !result.instructions.global.override) lines.push("  none");
  if (result.instructions.global.agents) {
    lines.push(`  ${result.instructions.global.agents.path}  ${result.instructions.global.agents.bytes} B`);
  }
  if (result.instructions.global.override) {
    lines.push(`  ${result.instructions.global.override.path}  ${result.instructions.global.override.bytes} B`);
  }
  if (result.instructions.global.effective) {
    lines.push(`  effective  ${result.instructions.global.effective}`);
  }
  if (result.instructions.projectDocMaxBytes !== undefined) {
    lines.push(`  project document limit  ${result.instructions.projectDocMaxBytes} B`);
  }
  lines.push("");
  lines.push("FINDINGS");
  if (result.findings.length === 0) lines.push("  none");
  for (const finding of result.findings) {
    lines.push(`  ${severity(finding.severity, color)}  ${finding.id}  ${redactUrls(finding.message)}  (${finding.evidence.path}${finding.evidence.line ? `:${finding.evidence.line}` : ""})`);
  }
  lines.push("");
  lines.push(`${paint(BOLD, "STATUS")}  ${status(result.status, color)}  exit ${codexAuditExitCode(result)}`);
  lines.push("");
  return lines.join("\n");
}

export function toCodexAuditJson(result: CodexAuditResult) {
  return {
    ...result,
    target: redactUrls(result.target),
    configPath: redactUrls(result.configPath),
    exitCode: codexAuditExitCode(result),
    coverage: {
      ...result.coverage,
      reasons: result.coverage.reasons.map(redactUrls),
    },
    findings: result.findings.map((finding) => ({
      ...finding,
      message: redactUrls(finding.message),
      evidence: { ...finding.evidence, path: redactUrls(finding.evidence.path) },
    })),
  };
}

function status(value: "PASS" | "FAIL" | "DEGRADED" | "FULL" | "PARTIAL", color: boolean): string {
  if (!color) return value;
  if (value === "PASS" || value === "FULL") return `${GREEN}${value}${RESET}`;
  if (value === "FAIL") return `${RED}${value}${RESET}`;
  return `${YELLOW}${value}${RESET}`;
}

function severity(value: "info" | "warning" | "high", color: boolean): string {
  if (!color) return value.toUpperCase();
  if (value === "high") return `${RED}${value.toUpperCase()}${RESET}`;
  if (value === "warning") return `${YELLOW}${value.toUpperCase()}${RESET}`;
  return `${GREEN}${value.toUpperCase()}${RESET}`;
}
