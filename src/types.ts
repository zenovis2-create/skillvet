export const VERSION = "0.2.0";

export const SCORE_YELLOW = 30;
export const SCORE_RED = 70;

export type Verdict = "GREEN" | "YELLOW" | "RED";
export type TargetKind = "skill" | "mcp" | "unknown";
export type ScanProfile = "portable-agent-skill" | "claude-code";

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
  profile?: ScanProfile;
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

export interface CollectionEntry {
  name: string;
  path: string;
  link: boolean;
  result?: ScanResult;
  error?: string;
}

export interface CollectionSummary {
  discovered: number;
  scanned: number;
  errors: number;
  green: number;
  yellow: number;
  red: number;
}

export interface CollectionScanResult {
  version: string;
  target: string;
  resolvedPath: string;
  kind: "skill-collection";
  strict: boolean;
  profile: ScanProfile;
  verdict: Verdict;
  summary: CollectionSummary;
  entries: CollectionEntry[];
  skipped: SkippedFile[];
}

export type CodexAuditSeverity = "info" | "warning" | "high";

export interface CodexAuditEvidence {
  path: string;
  line?: number;
  valueHash: string;
}

export interface CodexAuditObservation {
  id: string;
  message: string;
  value: string | number | boolean;
  evidence: CodexAuditEvidence;
}

export interface CodexAuditFinding {
  id: string;
  severity: CodexAuditSeverity;
  message: string;
  evidence: CodexAuditEvidence;
}

export interface CodexSkillInventoryItem {
  name: string;
  manifestPath: string;
  link: boolean;
  enabled: boolean;
  listingBytes?: number;
}

export interface CodexMcpServer {
  name: string;
  transport: "command" | "url" | "unknown";
  endpointScope: "local" | "public" | "unknown";
  line: number;
}

export interface CodexPlugin {
  id: string;
  enabled: boolean | "unspecified";
  childSettings: number;
  trustedHookStates: number;
  line: number;
}

export interface CodexAuditResult {
  version: string;
  target: string;
  configPath: string;
  profile?: {
    name: string;
    configPath: string;
  };
  status: "PASS" | "FAIL" | "DEGRADED";
  coverage: {
    status: "FULL" | "PARTIAL";
    reasons: string[];
  };
  catalogue: {
    discovered: number;
    enabled: number;
    disabled: number;
    links: number;
    listingBytes: number;
  };
  skills: CodexSkillInventoryItem[];
  mcpServers: CodexMcpServer[];
  plugins: CodexPlugin[];
  observations: CodexAuditObservation[];
  findings: CodexAuditFinding[];
}

export interface CodexAuditOptions {
  profile?: string;
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
