export const VERSION = "0.1.1";

export const SCORE_YELLOW = 30;
export const SCORE_RED = 70;

export type Verdict = "GREEN" | "YELLOW" | "RED";
export type TargetKind = "skill" | "mcp" | "unknown";

export interface Finding {
  check: string;
  message: string;
  score: number;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  score: number;
  findings: Finding[];
}

export interface ScanOptions {
  strict?: boolean;
}

export interface ScanResult {
  version: string;
  target: string;
  resolvedPath: string;
  kind: TargetKind;
  verdict: Verdict;
  score: number;
  strict: boolean;
  thresholds: { yellow: number; red: number };
  checks: CheckResult[];
  findings: Finding[];
}

export interface TextFile {
  relPath: string;
  absPath: string;
  content: string;
}

export interface FileEntry {
  relPath: string;
  absPath: string;
  size: number;
}

export interface SkippedFile {
  relPath: string;
  reason: string;
}

export interface SkillManifest {
  name?: string;
  description?: string;
  allowedDomains: string[];
  rawFrontmatter: boolean;
  unexpectedFields: string[];
  invalidFields: string[];
  metadataValid: boolean;
}

export interface McpManifest {
  valid: boolean;
  source?: string;
}

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: unknown;
  homepage?: string;
  repository?: string | { url?: string; type?: string };
  mcp?: unknown;
  mcpServers?: unknown;
  mcpName?: string;
  keywords?: string[];
  bin?: unknown;
  main?: string;
  gypfile?: boolean;
}

export interface ScanContext {
  root: string;
  kind: TargetKind;
  skill?: SkillManifest;
  mcp?: McpManifest;
  pkg?: PackageJson;
  files: FileEntry[];
  textFiles: TextFile[];
  skippedFiles: SkippedFile[];
}
