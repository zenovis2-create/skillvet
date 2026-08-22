import { auditExitCode } from "./audit.js";
import type { AuditOptions, AuditResult, LoadSurface } from "./audit-types.js";
import { VERSION } from "./types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

export interface AuditReportOptions {
  json?: boolean;
  color?: boolean;
  auditOptions?: AuditOptions;
}

export function formatAuditReport(result: AuditResult, options: AuditReportOptions = {}): string {
  if (options.json) return JSON.stringify(toAuditJson(result, options.auditOptions), null, 2);
  return formatText(result, options.color ?? false, options.auditOptions);
}

export function toAuditJson(result: AuditResult, options: AuditOptions = {}) {
  return {
    version: result.version,
    target: result.target,
    provider: result.provider,
    coverage: result.coverage,
    assumedContext: result.assumedContext,
    status: result.status,
    exitCode: auditExitCode(result, options),
    surfaces: result.surfaces,
    observations: result.observations,
    findings: result.findings,
    evaluations: result.evaluations,
    suppressedEvaluations: result.suppressedEvaluations,
  };
}

function formatText(result: AuditResult, color: boolean, options: AuditOptions | undefined): string {
  const c = paint(color);
  const lines: string[] = [];
  lines.push(`${c.bold("skillvet")} ${c.dim(VERSION)}   audit  ${result.target}`);
  const version = result.provider.version ? `@${result.provider.version}` : "";
  lines.push(`provider  ${result.provider.id}${version}  (${result.provider.source}; ${result.provider.review})`);
  lines.push(
    `coverage  ${c.status(result.coverage.status)}${result.coverage.reasons.length ? `  ${result.coverage.reasons.length} limitation(s)` : ""}`,
  );
  for (const reason of result.coverage.reasons) lines.push(`  ${c.dim("•")} ${reason}`);
  if (result.provider.review === "unknown") {
    lines.push("  Run: skillvet audit . --detect-provider-version");
  }
  lines.push("");

  lines.push(c.dim("LOAD SURFACES"));
  if (result.surfaces.length === 0) lines.push("  —");
  for (const surface of result.surfaces) lines.push(`  ${surfaceLine(surface)}`);
  lines.push("");

  if (result.observations.length > 0) {
    lines.push(c.dim("FILE FACTS / DETECTED CONFIGURATION"));
    for (const observation of result.observations) {
      lines.push(`  ${observation.id}  ${observation.evidence.path}${observation.evidence.pointer ?? ""}`);
    }
    lines.push("");
  }

  lines.push(c.dim("FINDINGS"));
  if (result.findings.length === 0) lines.push("  —");
  for (const finding of result.findings) {
    const eligibility = finding.ci.eligible ? "eligible" : "not eligible";
    lines.push(
      `  ${c.severity(finding.severity, finding.severity.toUpperCase())}  ${finding.dimension}/${finding.surface}  ${finding.id}  ${finding.message} (${eligibility})`,
    );
  }
  if (result.suppressedEvaluations.length > 0) {
    lines.push("");
    lines.push(c.dim("SUPPRESSED_BY_REVIEW_EXPIRY"));
    for (const item of result.suppressedEvaluations) {
      lines.push(`  ${item.id}  ${item.reason}; re-run with --require-reviewed or --fail-on-unreviewed`);
    }
  }
  lines.push("");
  const exitCode = auditExitCode(result, options);
  lines.push(`${c.bold("STATUS")}  ${c.status(result.status)}  exit ${exitCode}`);
  lines.push("");
  return lines.join("\n");
}

function surfaceLine(surface: LoadSurface): string {
  const parts = [surface.id];
  if (surface.rawBytes !== undefined) parts.push(`raw ${surface.rawBytes} B`);
  if (surface.injectedBytes !== undefined) parts.push(`injected ${surface.injectedBytes} B`);
  if (surface.listingLower !== undefined) parts.push(`listing_lower ${surface.listingLower} B`);
  if (surface.listingUpper !== undefined) parts.push(`listing_upper ${surface.listingUpper} B`);
  if (surface.overflowAtAssumedContext !== undefined) {
    parts.push(`overflow@assumed ${surface.overflowAtAssumedContext ? "YES" : "NO"}`);
  }
  parts.push(surface.measurement);
  return parts.join("  ");
}

function paint(enabled: boolean) {
  const wrap = (code: string, text: string) => enabled ? `${code}${text}${RESET}` : text;
  return {
    bold: (text: string) => wrap(BOLD, text),
    dim: (text: string) => wrap(DIM, text),
    status: (value: AuditResult["status"] | AuditResult["coverage"]["status"]) => {
      if (!enabled) return value;
      if (value === "PASS" || value === "FULL") return `${GREEN}${value}${RESET}`;
      if (value === "FAIL") return `${RED}${value}${RESET}`;
      return `${YELLOW}${value}${RESET}`;
    },
    severity: (severity: string, text: string) => {
      if (!enabled) return text;
      if (severity === "critical" || severity === "high") return `${RED}${text}${RESET}`;
      if (severity === "warning") return `${YELLOW}${text}${RESET}`;
      return `${GREEN}${text}${RESET}`;
    },
  };
}
