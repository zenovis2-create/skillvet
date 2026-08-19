import { open } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, FileEntry, Finding, ScanContext } from "../types.js";
import { finish } from "./manifest.js";

const EXEC_EXT = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".node",
  ".com",
  ".bat",
  ".cmd",
  ".msi",
  ".dmg",
  ".app",
]);

const ASSET_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".html",
  ".css",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".map",
  ".lock",
]);

const TEXT_NAMES = new Set([
  "license",
  "licence",
  "copying",
  "authors",
  "contributors",
  "makefile",
  "dockerfile",
  "procfile",
  "skill.md",
  "readme",
  "readme.md",
  "changelog",
  "changelog.md",
]);

export async function checkBinariesAsync(ctx: ScanContext): Promise<CheckResult> {
  const findings: Finding[] = [];

  for (const file of ctx.files) {
    const reason = await classifyBinary(file);
    if (!reason) continue;
    findings.push({
      check: "binaries",
      message: reason,
      file: file.relPath,
      score: 30,
    });
  }

  return finish("binaries", "binaries", findings, 50);
}

export async function classifyBinary(file: FileEntry): Promise<string | undefined> {
  const base = path.basename(file.relPath).toLowerCase();
  const ext = path.extname(file.relPath).toLowerCase();
  if (TEXT_NAMES.has(base)) return undefined;

  if (EXEC_EXT.has(ext)) {
    return `executable-shaped file (${ext})`;
  }

  const head = await readHead(file.absPath);
  if (!head) return undefined;

  const magic = detectMagic(head);
  if (magic) return `binary blob (${magic})`;

  if (ASSET_EXT.has(ext)) return undefined;
  if (!ext && looksBinary(head)) {
    return "extensionless binary blob";
  }
  return undefined;
}

async function readHead(file: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function detectMagic(head: Buffer): string | undefined {
  if (head.length < 2) return undefined;
  if (head[0] === 0x4d && head[1] === 0x5a) return "PE/MZ";
  if (
    head.length >= 4 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    return "ELF";
  }
  if (head.length >= 4) {
    const b0 = head[0];
    const b1 = head[1];
    const b2 = head[2];
    const b3 = head[3];
    if (
      (b0 === 0xcf && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) ||
      (b0 === 0xce && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) ||
      (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && b3 === 0xce) ||
      (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && b3 === 0xcf) ||
      (b0 === 0xca && b1 === 0xfe && b2 === 0xba && b3 === 0xbe)
    ) {
      return "Mach-O";
    }
  }
  return undefined;
}

function looksBinary(head: Buffer): boolean {
  if (head.includes(0)) return true;
  return false;
}
