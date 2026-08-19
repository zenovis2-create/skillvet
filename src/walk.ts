import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { FileEntry, Finding, SkippedFile, TextFile } from "./types.js";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

const TEXT_EXT = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".jsx",
  ".tsx",
  ".json",
  ".md",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
  ".html",
  ".css",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".ps1",
  ".fish",
  ".rb",
  ".php",
  ".go",
  ".rs",
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
  ".lua",
  ".pl",
  ".r",
  ".vue",
  ".svelte",
  ".gradle",
  ".graphql",
  ".gyp",
  ".gypi",
]);

const BINARY_ASSET_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".mp3",
  ".mp4",
  ".mov",
  ".webm",
  ".wav",
  ".flac",
]);

export const MAX_TEXT_BYTES = 1_000_000;
const TEXT_PROBE_BYTES = 4_096;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function isTextPath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return TEXT_EXT.has(ext) || ext === "";
}

function isKnownBinaryAssetPath(relPath: string): boolean {
  return BINARY_ASSET_EXT.has(path.extname(relPath).toLowerCase());
}

export async function listFiles(
  root: string,
  skipped: SkippedFile[] = [],
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  await walk(root, root, out, skipped);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function walk(
  root: string,
  dir: string,
  out: FileEntry[],
  skipped: SkippedFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    skipped.push({
      relPath: toPosix(path.relative(root, dir)) || ".",
      reason: "directory could not be read",
    });
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = toPosix(path.relative(root, absPath));
    let info;
    try {
      info = await lstat(absPath);
    } catch {
      skipped.push({ relPath, reason: "entry metadata could not be read" });
      continue;
    }
    if (info.isSymbolicLink()) {
      skipped.push({ relPath, reason: "symbolic link was not inspected" });
      continue;
    }
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        skipped.push({ relPath, reason: "directory is excluded from scanning" });
        continue;
      }
      await walk(root, absPath, out, skipped);
      continue;
    }
    if (!info.isFile()) {
      skipped.push({ relPath, reason: "non-regular filesystem entry was not inspected" });
      continue;
    }
    out.push({
      absPath,
      size: info.size,
      relPath,
    });
  }
}

export async function readTextFiles(
  files: FileEntry[],
  skipped: SkippedFile[] = [],
): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const file of files) {
    let handle;
    try {
      handle = await open(file.absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const current = await handle.stat();
      if (!current.isFile()) {
        skipped.push({ relPath: file.relPath, reason: "entry changed before inspection" });
        continue;
      }
      const knownText = isTextPath(file.relPath);
      if (!knownText) {
        const probe = Buffer.alloc(Math.min(TEXT_PROBE_BYTES, current.size));
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        if (!looksTextual(probe.subarray(0, bytesRead), true)) {
          if (!isKnownBinaryAssetPath(file.relPath)) {
            skipped.push({
              relPath: file.relPath,
              reason: "unrecognized non-text file was not inspected",
            });
          }
          continue;
        }
      }
      if (current.size > MAX_TEXT_BYTES) {
        skipped.push({
          relPath: file.relPath,
          reason: `text-shaped file is too large to inspect (${current.size} bytes)`,
        });
        continue;
      }
      const buf = Buffer.alloc(MAX_TEXT_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_TEXT_BYTES) {
        skipped.push({
          relPath: file.relPath,
          reason: `text file is too large to inspect (over ${MAX_TEXT_BYTES} bytes)`,
        });
        continue;
      }
      const content = buf.subarray(0, bytesRead);
      if (content.includes(0)) {
        skipped.push({ relPath: file.relPath, reason: "text-shaped file contains NUL bytes" });
        continue;
      }
      if (!looksTextual(content)) {
        skipped.push({
          relPath: file.relPath,
          reason: "text-shaped file is not valid UTF-8 or contains binary control bytes",
        });
        continue;
      }
      out.push({
        relPath: file.relPath,
        absPath: file.absPath,
        content: UTF8_DECODER.decode(content),
      });
    } catch {
      skipped.push({ relPath: file.relPath, reason: "text file could not be read" });
    } finally {
      await handle?.close();
    }
  }
  return out;
}

function looksTextual(content: Buffer, allowIncompleteTail = false): boolean {
  if (content.length === 0) return true;
  if (content.includes(0)) return false;
  try {
    if (allowIncompleteTail) {
      new TextDecoder("utf-8", { fatal: true }).decode(content, { stream: true });
    } else {
      UTF8_DECODER.decode(content);
    }
  } catch {
    return false;
  }
  let controls = 0;
  for (const byte of content) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      controls += 1;
    }
  }
  return controls / content.length <= 0.01;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function eachLine(
  content: string,
  fn: (line: string, lineNo: number) => void,
): void {
  const lines = content.split(/\r\n|\r|\n|\u2028|\u2029/);
  for (let i = 0; i < lines.length; i++) fn(lines[i] ?? "", i + 1);
}

export function clip(s: string, max = 80): string {
  const t = redactUrls(s).trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const EVIDENCE_URL_RE =
  /\b(?:https?|wss?|ipc|unix|npipe):(?:(?!\b(?:https?|wss?|ipc|unix|npipe):)[^"'`])+/gi;

export function normalizeUrlText(value: string): {
  text: string;
  lineNumbers: number[];
} {
  let text = "";
  let lineNo = 1;
  const lineNumbers: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i] ?? "";
    const isLineTerminator =
      char === "\r" || char === "\n" || char === "\u2028" || char === "\u2029";
    const isLineContinuation =
      isLineTerminator && value[i - 1] === "\\" && text.endsWith("\\");
    if (isLineContinuation) {
      text = text.slice(0, -1);
      lineNumbers.pop();
    }
    if (char === "\t") continue;
    if (char === "\r") {
      if (value[i + 1] !== "\n") lineNo += 1;
      continue;
    }
    if (char === "\n") {
      lineNo += 1;
      continue;
    }
    if ((char === "\u2028" || char === "\u2029") && isLineContinuation) {
      lineNo += 1;
      continue;
    }
    text += char;
    lineNumbers.push(lineNo);
    if (char === "\u2028" || char === "\u2029") lineNo += 1;
  }
  return { text, lineNumbers };
}

export function redactUrls(value: string): string {
  const normalized = normalizeUrlText(value).text;
  return normalized.replace(EVIDENCE_URL_RE, (raw) => {
    const candidate = raw.replace(/[.,;:!?)\]}><(]+$/g, "");
    try {
      const url = new URL(candidate);
      const opaqueIpc =
        /^(?:ipc|unix|npipe):/i.test(candidate) &&
        !/^(?:ipc|unix|npipe):\/\//i.test(candidate);
      if (opaqueIpc) {
        const pathname = url.pathname.includes("@")
          ? url.pathname.slice(url.pathname.lastIndexOf("@") + 1)
          : url.pathname;
        return `${url.protocol}${pathname}`;
      }
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "<redacted URL>";
    }
  });
}

export function createFindingClipper(
  content: string,
): (line: string, lineNo: number, max?: number) => string {
  const view = normalizeUrlText(content);
  const ranges: { startLine: number; endLine: number; raw: string }[] = [];
  EVIDENCE_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EVIDENCE_URL_RE.exec(view.text))) {
    const start = match.index;
    const end = start + (match[0]?.length ?? 0) - 1;
    const startLine = view.lineNumbers[start] ?? 1;
    const endLine = view.lineNumbers[end] ?? startLine;
    if (startLine !== endLine) {
      ranges.push({ startLine, endLine, raw: match[0] ?? "" });
    }
  }
  return (line: string, lineNo: number, max = 80): string => {
    const range = ranges.find((item) => lineNo >= item.startLine && lineNo <= item.endLine);
    return clip(range?.raw ?? line, max);
  };
}

export function redactFinding(finding: Finding): Finding {
  const redacted = { ...finding, message: redactUrls(finding.message) };
  if (redacted.file !== undefined) redacted.file = redactUrls(redacted.file);
  if (redacted.evidence !== undefined) redacted.evidence = redactUrls(redacted.evidence);
  return redacted;
}
