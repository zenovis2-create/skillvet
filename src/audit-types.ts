export type AuditDimension = "context" | "hook" | "config" | "conflict" | "security";
export type AuditConfidence = "deterministic" | "heuristic" | "observed";
export type AuditSurface = "main" | "conditional" | "skill" | "subagent";
export type AuditSeverity = "info" | "warning" | "high" | "critical";
export type AuditReview = "reviewed" | "unreviewed" | "unknown";
export type AuditCoverageStatus = "FULL" | "PARTIAL";

export interface AuditEvidence {
  path: string;
  pointer?: string;
  line?: number;
  valueHash: string;
}

export interface AuditCiPolicy {
  eligible: boolean;
  defaultFail: boolean;
}

export interface AuditFinding {
  id: string;
  dimension: AuditDimension;
  confidence: AuditConfidence;
  surface: AuditSurface;
  severity: AuditSeverity;
  ci: AuditCiPolicy;
  message: string;
  evidence: AuditEvidence;
}

export interface AuditObservation {
  id: string;
  kind: string;
  message: string;
  value: string | number | boolean;
  evidence: AuditEvidence;
}

export interface AuditEvaluation {
  id: string;
  dimension: AuditDimension;
  confidence: AuditConfidence;
  since: string;
  until?: string;
  evaluated: boolean;
  eligible: boolean;
  outcome: "clean" | "finding" | "not-modeled" | "unknown-version";
}

export interface SuppressedEvaluation {
  id: string;
  reason: string;
  evidence: AuditEvidence;
}

export interface LoadSurface {
  id: string;
  surface: AuditSurface;
  rawBytes?: number;
  injectedBytes?: number;
  listingLower?: number;
  listingUpper?: number;
  overflowAtAssumedContext?: boolean;
  measurement: "observed" | "candidate" | "measured" | "partial";
}

export interface AuditProvider {
  id: "claude-code";
  version?: string;
  source: "declared" | "detected" | "unknown";
  behaviorRuleset: string | "unknown";
  review: AuditReview;
  reviewedThrough?: string;
}

export interface AuditCoverage {
  status: AuditCoverageStatus;
  reasons: string[];
}

export interface AuditResult {
  version: string;
  target: string;
  provider: AuditProvider;
  coverage: AuditCoverage;
  assumedContext: number;
  surfaces: LoadSurface[];
  observations: AuditObservation[];
  findings: AuditFinding[];
  evaluations: AuditEvaluation[];
  suppressedEvaluations: SuppressedEvaluation[];
  status: "PASS" | "FAIL" | "DEGRADED";
}

export interface AuditOptions {
  provider?: string;
  detectProviderVersion?: boolean;
  failOn?: string[];
  failOnUnreviewed?: boolean;
  requireReviewed?: boolean;
  assumeContext?: number;
}
