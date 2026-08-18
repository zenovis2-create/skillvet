import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileEntry, TextFile } from "./types.js";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".skillvet-cache",
  ".tmp",
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
]);

const MAX_TEXT_BYTES = 1_000_000;

export function isTextPath(relPath: string): boolean {
  return TEXT_EXT.has(path.extname(relPath).toLowerCase());
}

export async function listFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  await walk(root, root, out);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function walk(root: string, dir: string, out: FileEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const absPath = path.join(dir, entry.name);
    let size = 0;
    try {
      size = (await stat(absPath)).size;
    } catch {
      continue;
    }
    out.push({
      absPath,
      size,
      relPath: toPosix(path.relative(root, absPath)),
    });
  }
}

export async function readTextFiles(files: FileEntry[]): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const file of files) {
    if (!isTextPath(file.relPath)) continue;
    if (file.size > MAX_TEXT_BYTES) continue;
    let buf: Buffer;
    try {
      buf = await readFile(file.absPath);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    out.push({
      relPath: file.relPath,
      absPath: file.absPath,
      content: buf.toString("utf8"),
    });
  }
  return out;
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
