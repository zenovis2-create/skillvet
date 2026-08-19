import type { CheckResult, Finding, ScanContext } from "../types.js";
import { createFindingClipper, eachLine } from "../walk.js";
import { finish } from "./manifest.js";

const DOC_FILES = new Set(["readme.md", "changelog.md", "license", "license.md"]);

const PATTERNS: { re: RegExp; message: string; score: number }[] = [
  {
    re: /Buffer\.from\s*\([^)]*['"]base64['"]/,
    message: "decodes base64 via Buffer.from(..., 'base64')",
    score: 20,
  },
  { re: /\batob\s*\(/, message: "decodes base64 via atob(", score: 20 },
  {
    re: /eval\s*\(\s*['"]\\x[0-9a-f]/i,
    message: "eval() on a hex-escaped string",
    score: 25,
  },
  {
    re: /Function\s*\(\s*['"]\\x[0-9a-f]/i,
    message: "Function() on a hex-escaped string",
    score: 25,
  },
  {
    re: /eval\s*\(\s*['"][0-9a-f]{24,}/i,
    message: "eval() on a long hex string",
    score: 25,
  },
  {
    re: /String\.fromCharCode\s*\(\s*\d+(?:\s*,\s*\d+){8,}/,
    message: "builds a string from a long fromCharCode sequence",
    score: 20,
  },
];

export function checkObfuscation(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const file of ctx.textFiles) {
    const base = file.relPath.split("/").pop()?.toLowerCase() ?? "";
    if (DOC_FILES.has(base)) continue;
    const clipLine = createFindingClipper(file.content);

    eachLine(file.content, (line, lineNo) => {
      for (const pat of PATTERNS) {
        if (!pat.re.test(line)) continue;
        const key = `${pat.message}:${file.relPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          check: "obfuscation",
          message: pat.message,
          file: file.relPath,
          line: lineNo,
          evidence: clipLine(line, lineNo),
          score: pat.score,
        });
      }
    });

    const mini = minifiedFinding(file.relPath, file.content);
    if (mini) findings.push(mini);
  }

  return finish("obfuscation", "obfuscation", findings, 40);
}

export function isMinified(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  const total = lines.reduce((a, l) => a + l.length, 0);
  const avg = total / lines.length;
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest >= 5000) return true;
  if (lines.length <= 3 && total >= 10_000) return true;
  if (lines.length > 10 && avg > 250) return true;
  if (lines.length > 5 && longest > 500 && avg > 200) return true;
  return false;
}

function minifiedFinding(relPath: string, content: string): Finding | undefined {
  if (!isMinified(content)) return undefined;
  return {
    check: "obfuscation",
    message: "file looks minified (long lines / high avg line length)",
    file: relPath,
    score: 15,
  };
}
