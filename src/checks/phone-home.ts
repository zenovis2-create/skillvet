import path from "node:path";
import { hostFromUrl, normalizeHost } from "../manifest.js";
import type { CheckResult, Finding, ScanContext, TextFile } from "../types.js";
import {
  clip,
  createFindingClipper,
  eachLine,
  normalizeUrlText,
  redactUrls,
} from "../walk.js";
import { finish } from "./manifest.js";

const DOC_FILES = new Set(["readme.md", "changelog.md", "license", "license.md"]);
const DOCUMENT_EXT = new Set([
  "",
  ".md",
  ".markdown",
  ".mdown",
  ".mdx",
  ".mkd",
  ".mkdn",
  ".txt",
]);

const URL_RE =
  /(?:https?|wss?):(?:\/\/)?(?:(?!\b(?:https?|wss?|ipc|unix|npipe):)[^"'`])+/gi;
const IPC_RE =
  /\b(?:ipc|unix|npipe):(?:\/\/)?(?:(?!\b(?:https?|wss?|ipc|unix|npipe):)[^"'`])+/gi;
const HASH_COMMENT_EXT = new Set([
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".rb",
  ".pl",
  ".r",
  ".php",
  ".ps1",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".gyp",
  ".gypi",
  ".graphql",
  ".coffee",
]);
const SLASH_COMMENT_EXT = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".jsx",
  ".tsx",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".scala",
  ".go",
  ".rs",
  ".php",
  ".gradle",
  ".vue",
  ".svelte",
]);

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
    if (!isScannableFile(file)) continue;
    const ext = path.extname(file.relPath).toLowerCase();
    const isSkillInstructions = path.basename(file.relPath).toLowerCase() === "skill.md";
    const sourceLines = file.content.split(/\r\n|\r|\n/);
    const clipLine = createFindingClipper(file.content);

    if (!SKIP_URL_FILES.has(path.basename(file.relPath))) {
      const shouldSkipLine = (lineNo: number): boolean =>
        !isSkillInstructions &&
        !DOCUMENT_EXT.has(ext) &&
        isSourceComment(sourceLines[lineNo - 1] ?? "", ext);
      eachLine(file.content, (line, lineNo) => {
        const lineView = normalizeUrlText(line);
        const lineNumbers = new Array<number>(lineView.text.length).fill(lineNo);
        collectUrls(
          lineView.text,
          URL_RE,
          file,
          lineNumbers,
          shouldSkipLine,
          allowed,
          seenHosts,
          findings,
        );
        collectUrls(
          lineView.text,
          IPC_RE,
          file,
          lineNumbers,
          shouldSkipLine,
          allowed,
          seenHosts,
          findings,
          true,
        );
      });
      const urlView = normalizeUrlText(file.content);
      collectUrls(
        urlView.text,
        URL_RE,
        file,
        urlView.lineNumbers,
        shouldSkipLine,
        allowed,
        seenHosts,
        findings,
      );
      collectUrls(
        urlView.text,
        IPC_RE,
        file,
        urlView.lineNumbers,
        shouldSkipLine,
        allowed,
        seenHosts,
        findings,
        true,
      );
    }

    eachLine(file.content, (line, lineNo) => {
      if (
        !isSkillInstructions &&
        !DOCUMENT_EXT.has(ext) &&
        isSourceComment(line, ext)
      ) {
        return;
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
          evidence: clipLine(line, lineNo),
          score: prim.score,
        });
      }
    });
  }

  return finish("phone-home", "phone-home", findings, 60);
}

function isSourceComment(line: string, ext: string): boolean {
  const trimmed = line.trimStart();
  return Boolean(
    (trimmed.startsWith("#") && HASH_COMMENT_EXT.has(ext)) ||
      (trimmed.startsWith("//") && SLASH_COMMENT_EXT.has(ext)),
  );
}

function collectUrls(
  content: string,
  re: RegExp,
  file: TextFile,
  lineNumbers: number[],
  shouldSkipLine: (lineNo: number) => boolean,
  allowed: Set<string>,
  seenHosts: Set<string>,
  findings: Finding[],
  ipc = false,
): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const raw = stripTrailingPunct(match[0] ?? "");
    const startLine = lineNumbers[match.index] ?? 1;
    const endLine = lineNumbers[match.index + Math.max(raw.length - 1, 0)] ?? startLine;
    if (startLine === endLine && shouldSkipLine(startLine)) continue;
    if (ipc) {
      const key = `ipc:${raw}`;
      if (seenHosts.has(key)) continue;
      seenHosts.add(key);
      findings.push({
        check: "phone-home",
        message: `outbound IPC endpoint ${redactUrls(raw)}`,
        file: file.relPath,
        line: startLine,
        evidence: clip(raw),
        score: 30,
      });
      continue;
    }
    const host = hostFromUrl(raw);
    if (!host) continue;
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    const declared = allowed.has(host);
    findings.push({
      check: "phone-home",
      message: `${declared ? "declared" : "undeclared"} outbound host ${host}`,
      file: file.relPath,
      line: startLine,
      evidence: clip(raw),
      score: declared ? 35 : 40,
    });
  }
}

function isScannableFile(file: TextFile): boolean {
  const base = path.basename(file.relPath).toLowerCase();
  return !DOC_FILES.has(base);
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]}><(]+$/g, "");
}
