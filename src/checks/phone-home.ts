import path from "node:path";
import { hostFromUrl, normalizeHost } from "../manifest.js";
import type { CheckResult, Finding, ScanContext, TextFile } from "../types.js";
import { clip, eachLine } from "../walk.js";
import { finish } from "./manifest.js";

const CODE_EXT = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".jsx",
  ".tsx",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".json",
]);

const DOC_FILES = new Set(["skill.md", "readme.md", "changelog.md", "license", "license.md"]);

const URL_RE = /(?:https?|wss?):\/\/[^\s"'`\\)<>]+/gi;
const IPC_RE = /\b(?:ipc|unix|npipe):\/\/[^\s"'`\\)<>]+/gi;

const PRIMITIVES: { re: RegExp; message: string; score: number; langs?: Set<string> }[] = [
  {
    re: /\b(?:node:)?child_process\b/,
    message: "imports or references child_process",
    score: 20,
  },
  { re: /\bexecSync\s*\(/, message: "calls execSync(", score: 20 },
  { re: /\bexecFile(?:Sync)?\s*\(/, message: "calls execFile(", score: 20 },
  { re: /\bspawn(?:Sync)?\s*\(/, message: "calls spawn(", score: 20 },
  { re: /\bfork\s*\(/, message: "calls fork(", score: 20 },
  { re: /\beval\s*\(/, message: "calls eval(", score: 20 },
  { re: /\bnew\s+Function\s*\(/, message: "constructs new Function(", score: 20 },
  { re: /(?<![.\w])Function\s*\(/, message: "calls Function(", score: 20 },
  {
    re: /\bsubprocess\b/,
    message: "uses subprocess",
    score: 20,
    langs: new Set([".py"]),
  },
  {
    re: /\bos\.system\s*\(/,
    message: "calls os.system(",
    score: 20,
    langs: new Set([".py"]),
  },
  {
    re: /(?<![.\w])exec\s*\(/,
    message: "calls exec(",
    score: 20,
    langs: new Set([".py"]),
  },
  {
    re: /\b(?:curl|wget)\b/,
    message: "shells out to curl/wget",
    score: 25,
    langs: new Set([".sh", ".bash", ".zsh"]),
  },
];

const SKIP_URL_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

export function checkPhoneHome(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const allowed = new Set(
    (ctx.skill?.allowedDomains ?? []).map(normalizeHost),
  );
  const seenHosts = new Set<string>();
  const seenPrim = new Set<string>();

  for (const file of ctx.textFiles) {
    if (!isCodeFile(file.relPath)) continue;
    const ext = path.extname(file.relPath).toLowerCase();

    eachLine(file.content, (line, lineNo) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#")) return;

      if (!SKIP_URL_FILES.has(path.basename(file.relPath))) {
        collectUrls(line, URL_RE, file, lineNo, allowed, seenHosts, findings);
        collectUrls(line, IPC_RE, file, lineNo, allowed, seenHosts, findings, true);
      }

      for (const prim of PRIMITIVES) {
        if (prim.langs && !prim.langs.has(ext)) continue;
        if (!prim.re.test(line)) continue;
        const key = `${prim.message}:${file.relPath}`;
        if (seenPrim.has(key)) continue;
        seenPrim.add(key);
        findings.push({
          check: "phone-home",
          message: prim.message,
          file: file.relPath,
          line: lineNo,
          evidence: clip(line),
          score: prim.score,
        });
      }
    });
  }

  return finish("phone-home", "phone-home", findings, 60);
}

function collectUrls(
  line: string,
  re: RegExp,
  file: TextFile,
  lineNo: number,
  allowed: Set<string>,
  seenHosts: Set<string>,
  findings: Finding[],
  ipc = false,
): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const raw = stripTrailingPunct(match[0] ?? "");
    if (ipc) {
      const key = `ipc:${raw}`;
      if (seenHosts.has(key)) continue;
      seenHosts.add(key);
      findings.push({
        check: "phone-home",
        message: `outbound IPC endpoint ${raw}`,
        file: file.relPath,
        line: lineNo,
        evidence: clip(line),
        score: 25,
      });
      continue;
    }
    const host = hostFromUrl(raw);
    if (!host) continue;
    if (allowed.has(host)) continue;
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    findings.push({
      check: "phone-home",
      message: `undeclared outbound host ${host}`,
      file: file.relPath,
      line: lineNo,
      evidence: clip(raw),
      score: 40,
    });
  }
}

function isCodeFile(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  if (DOC_FILES.has(base)) return false;
  return CODE_EXT.has(path.extname(relPath).toLowerCase());
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]]+$/g, "");
}
