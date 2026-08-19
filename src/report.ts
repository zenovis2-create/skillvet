import { exitCodeFor } from "./score.js";
import { redactTarget } from "./safe-http.js";
import { VERSION, type CheckResult, type Finding, type ScanResult, type Verdict } from "./types.js";
import { redactUrls } from "./walk.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";


export interface ReportOptions {
  json?: boolean;
  color?: boolean;
}

export function formatReport(result: ScanResult, options: ReportOptions = {}): string {
  if (options.json) {
    return JSON.stringify(toJson(result), null, 2);
  }
  const color = options.color ?? false;
  return formatTable(result, color);
}

export function toJson(result: ScanResult) {
  return {
    version: result.version,
    target: redactTarget(result.target),
    resolvedPath: redactUrls(result.resolvedPath),
    kind: result.kind,
    verdict: result.verdict,
    score: result.score,
    strict: result.strict,
    thresholds: result.thresholds,
    exitCode: exitCodeFor(result.verdict),
    checks: result.checks.map((c) => ({
      id: c.id,
      score: c.score,
      findings: c.findings.map(sanitizeFinding),
    })),
    findings: result.findings.map(sanitizeFinding),
  };
}

function formatTable(result: ScanResult, color: boolean): string {
  const c = paint(color);
  const lines: string[] = [];
  lines.push(`${c.bold("skillvet")} ${c.dim(VERSION)}   scan  ${redactTarget(result.target)}`);
  lines.push(`${c.dim("kind")} ${result.kind}${result.strict ? c.dim("   --strict") : ""}`);
  lines.push("");
  lines.push(c.dim(row("check", "pts", "status", "notes")));
  lines.push(c.dim(row("─".repeat(16), "───", "──────", "─".repeat(44))));

  for (const check of result.checks) {
    const status = statusFor(check);
    const notes = notesFor(check);
    lines.push(
      row(
        check.title,
        check.score === 0 ? "0" : `+${check.score}`,
        c.status(status),
        notes,
      ),
    );
  }

  lines.push("");
  if (result.findings.length > 0) {
    lines.push(c.dim("findings"));
    for (const f of result.findings) {
      const safe = sanitizeFinding(f);
      const loc = safe.file ? `${safe.file}${safe.line ? `:${safe.line}` : ""}` : "";
      const locBit = loc ? c.dim(`  ${loc}`) : "";
      lines.push(`  ${c.dim("•")} ${safe.message}${locBit}`);
    }
    lines.push("");
  }

  const banner = `${result.verdict}   ${result.score}/100`;
  lines.push(`${c.bold("VERDICT")}  ${c.verdict(result.verdict, banner)}`);
  lines.push("");
  return lines.join("\n");
}

function statusFor(check: CheckResult): Verdict {
  if (check.score >= 70) return "RED";
  if (check.score > 0) return "YELLOW";
  return "GREEN";
}

function notesFor(check: CheckResult): string {
  if (check.findings.length === 0) return "—";
  const first = check.findings[0];
  if (!first) return "—";
  const message = redactUrls(first.message);
  if (check.findings.length === 1) return message;
  return `${message}  (+${check.findings.length - 1} more)`;
}

function sanitizeFinding(finding: Finding): Finding {
  const sanitized = { ...finding, message: redactUrls(finding.message) };
  if (sanitized.file !== undefined) sanitized.file = redactUrls(sanitized.file);
  if (sanitized.evidence !== undefined) sanitized.evidence = redactUrls(sanitized.evidence);
  return sanitized;
}

function row(a: string, b: string, d: string, e: string): string {
  const left = pad(a, 16);
  const pts = pad(b, 5);
  const st = padVisible(d, 8);
  return `${left} ${pts} ${st} ${e}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padVisible(s: string, n: number): string {
  const vis = visibleLen(s);
  return vis >= n ? s : s + " ".repeat(n - vis);
}

function visibleLen(s: string): number {
  return strip(s).length;
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function paint(enabled: boolean) {
  const wrap = (code: string, s: string) => (enabled ? `${code}${s}${RESET}` : s);
  return {
    bold: (s: string) => wrap(BOLD, s),
    dim: (s: string) => wrap(DIM, s),
    status: (v: Verdict) => {
      if (!enabled) return v;
      if (v === "GREEN") return `${GREEN}${v}${RESET}`;
      if (v === "YELLOW") return `${YELLOW}${v}${RESET}`;
      return `${RED}${v}${RESET}`;
    },
    verdict: (v: Verdict, s: string) => {
      if (!enabled) return s;
      if (v === "GREEN") return `${BOLD}${GREEN}${s}${RESET}`;
      if (v === "YELLOW") return `${BOLD}${YELLOW}${s}${RESET}`;
      return `${BOLD}${RED}${s}${RESET}`;
    },
  };
}

export function shouldColor(opts: { json?: boolean; noColor?: boolean }): boolean {
  if (opts.json || opts.noColor) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}
