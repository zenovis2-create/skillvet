import {
  SCORE_RED,
  SCORE_YELLOW,
  type Finding,
  type ScanOptions,
  type Verdict,
} from "./types.js";

export function sumScores(findings: Finding[], cap = 100): number {
  const total = findings.reduce((acc, f) => acc + f.score, 0);
  return Math.min(cap, Math.max(0, total));
}

export function verdictFor(score: number, strict = false): Verdict {
  const redAt = strict ? SCORE_YELLOW : SCORE_RED;
  const yellowAt = strict ? 1 : SCORE_YELLOW;
  if (score >= redAt) return "RED";
  if (score >= yellowAt) return "YELLOW";
  return "GREEN";
}

export function exitCodeFor(verdict: Verdict): number {
  if (verdict === "GREEN") return 0;
  if (verdict === "YELLOW") return 1;
  return 2;
}

export function scoreFindings(findings: Finding[], options: ScanOptions = {}) {
  const score = sumScores(findings);
  const verdict = verdictFor(score, options.strict);
  return { score, verdict };
}
