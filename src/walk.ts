import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { FileEntry, SkippedFile, TextFile } from "./types.js";

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
        if (!looksTextual(probe.subarray(0, bytesRead))) {
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
      out.push({
        relPath: file.relPath,
        absPath: file.absPath,
        content: content.toString("utf8"),
      });
    } catch {
      skipped.push({ relPath: file.relPath, reason: "text file could not be read" });
    } finally {
      await handle?.close();
    }
  }
  return out;
}

function looksTextual(content: Buffer): boolean {
  if (content.length === 0) return true;
  if (content.includes(0)) return false;
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
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) fn(lines[i] ?? "", i + 1);
}

export function clip(s: string, max = 80): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
