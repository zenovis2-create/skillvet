import type {
  AuditConfidence,
  AuditDimension,
  AuditSeverity,
} from "./audit-types.js";

export interface ProviderRule {
  id: string;
  dimension: AuditDimension;
  confidence: AuditConfidence;
  severity: AuditSeverity;
  defaultFail: boolean;
  since: string;
  until?: string;
}

export const CLAUDE_CODE_RULESET: {
  readonly id: string;
  readonly reviewedThrough: string;
  readonly checks: readonly ProviderRule[];
} = {
  id: "claude-code/docs-2026-08-22",
  reviewedThrough: "2.1.239",
  checks: [
    {
      id: "MATCH_ALL_HOOK",
      dimension: "hook",
      confidence: "deterministic",
      severity: "high",
      defaultFail: true,
      since: "2.1.0",
    },
    {
      id: "REMOTE_HTTP_HOOK",
      dimension: "security",
      confidence: "deterministic",
      severity: "info",
      defaultFail: false,
      since: "2.1.196",
    },
    {
      id: "HEADER_ENV_INTERPOLATION",
      dimension: "security",
      confidence: "deterministic",
      severity: "warning",
      defaultFail: false,
      since: "2.1.196",
    },
    {
      id: "POTENTIAL_CREDENTIAL_EGRESS",
      dimension: "security",
      confidence: "heuristic",
      severity: "warning",
      defaultFail: false,
      since: "2.1.196",
    },
    {
      id: "SKIPPED_BY_CLAUDE",
      dimension: "context",
      confidence: "deterministic",
      severity: "warning",
      defaultFail: false,
      since: "2.1.196",
    },
    {
      id: "SKILL_LISTING_OVERFLOW",
      dimension: "context",
      confidence: "deterministic",
      severity: "warning",
      defaultFail: false,
      since: "2.1.196",
    },
  ],
};

export function parseVersion(input: string): number[] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(input.trim());
  if (!match) return undefined;
  return [
    Number(match[1]),
    Number(match[2] ?? "0"),
    Number(match[3] ?? "0"),
  ];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`invalid provider version comparison: ${left}, ${right}`);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function appliesAtVersion(rule: ProviderRule, version: string): boolean {
  if (compareVersions(version, rule.since) < 0) return false;
  return !rule.until || compareVersions(version, rule.until) < 0;
}
