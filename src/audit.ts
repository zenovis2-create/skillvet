import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { parseFrontmatter } from "./manifest.js";
import {
  CLAUDE_CODE_RULESET,
  appliesAtVersion,
  compareVersions,
  parseVersion,
} from "./audit-rules.js";
import type {
  AuditCoverage,
  AuditEvidence,
  AuditEvaluation,
  AuditFinding,
  AuditObservation,
  AuditOptions,
  AuditProvider,
  AuditResult,
  AuditSurface,
  LoadSurface,
  SuppressedEvaluation,
} from "./audit-types.js";
import { VERSION } from "./types.js";
import { redactUrls, toPosix } from "./walk.js";

const execFile = promisify(execFileCallback);
const MAX_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const CLAUDE_SKIP_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_HOPS = 4;
const DEFAULT_ASSUMED_CONTEXT = 200_000;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "coverage", ".venv", "venv", "__pycache__"]);

interface WorkspaceFile {
  absPath: string;
  relPath: string;
  size: number;
}

interface HookHandler {
  type: string;
  url?: string;
  headers: Record<string, unknown>;
  pointer: string;
}

interface HookBlock {
  file: WorkspaceFile;
  event: string;
  matcher?: string;
  pointer: string;
  handlers: HookHandler[];
  value: unknown;
}

interface Candidate {
  message: string;
  evidence: AuditEvidence;
}

interface AuditBuild {
  target: string;
  provider: AuditProvider;
  coverage: AuditCoverage;
  assumedContext: number;
  surfaces: LoadSurface[];
  observations: AuditObservation[];
  candidates: Map<string, Candidate[]>;
}

export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
  const root = await resolveWorkspace(target);
  const coverageReasons: string[] = [];
  const provider = await resolveProvider(options, coverageReasons);
  const files = await collectWorkspaceFiles(root, coverageReasons);
  const build: AuditBuild = {
    target: redactUrls(target),
    provider,
    coverage: { status: "FULL", reasons: coverageReasons },
    assumedContext: options.assumeContext ?? DEFAULT_ASSUMED_CONTEXT,
    surfaces: [],
    observations: [],
    candidates: new Map(),
  };

  await collectLoadSurfaces(build, root, files, coverageReasons);
  await collectHooks(build, root, files, coverageReasons);
  build.coverage.status = coverageReasons.length === 0 ? "FULL" : "PARTIAL";

  const { findings, evaluations } = evaluateCandidates(build);
  const preliminary: Omit<AuditResult, "suppressedEvaluations" | "status"> = {
    version: VERSION,
    target: build.target,
    provider: build.provider,
    coverage: build.coverage,
    assumedContext: build.assumedContext,
    surfaces: build.surfaces,
    observations: build.observations,
    findings,
    evaluations,
  };
  const suppressedEvaluations = suppressedForReviewExpiry(preliminary, options);
  const exitCode = auditExitCode(preliminary, options);
  return {
    ...preliminary,
    suppressedEvaluations,
    status: exitCode === 2
      ? "FAIL"
      : exitCode === 3 || preliminary.coverage.status === "PARTIAL"
        ? "DEGRADED"
        : "PASS",
  };
}

export function auditExitCode(
  result: Pick<AuditResult, "provider" | "findings" | "evaluations">,
  options: AuditOptions = {},
): 0 | 2 | 3 {
  const selectors = options.failOn ?? [];
  const selectedFindings = result.findings.filter((finding) =>
    selectors.length > 0
      ? matchesSelector(finding.id, finding.dimension, selectors)
      : finding.dimension === "security" && finding.ci.defaultFail,
  );
  const failing = selectedFindings.filter((finding) =>
    isEligibleFinding(finding, result.provider, options),
  );
  if (failing.length > 0) return 2;

  if (options.requireReviewed && result.provider.review !== "reviewed") return 3;
  if (selectors.length > 0) {
    const everySelectorEvaluated = selectors.every((selector) =>
      result.evaluations.some((evaluation) =>
        matchesSelector(evaluation.id, evaluation.dimension, [selector]) &&
        isEligibleEvaluation(evaluation, result.provider, options),
      ),
    );
    if (!everySelectorEvaluated) return 3;
  }
  return 0;
}

async function resolveWorkspace(target: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new Error("audit accepts a local workspace path, not a URL");
  }
  const candidate = path.resolve(target);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error(`workspace path not found: ${redactUrls(target)}`);
  }
  if (!info.isDirectory()) throw new Error(`workspace path is not a directory: ${redactUrls(target)}`);
  return realpath(candidate);
}

async function resolveProvider(options: AuditOptions, reasons: string[]): Promise<AuditProvider> {
  let raw = options.provider;
  let source: AuditProvider["source"] = raw ? "declared" : "unknown";
  if (!raw && options.detectProviderVersion) {
    raw = await detectClaudeVersion();
    source = raw ? "detected" : "unknown";
  }

  const parsed = parseProvider(raw);
  if (!parsed.version) {
    addReason(reasons, "UNKNOWN_PROVIDER_VERSION: version-gated checks were not evaluated");
    return {
      id: "claude-code",
      source: "unknown",
      behaviorRuleset: "unknown",
      review: "unknown",
    };
  }

  const review = compareVersions(parsed.version, CLAUDE_CODE_RULESET.reviewedThrough) > 0
    ? "unreviewed"
    : "reviewed";
  if (review === "unreviewed") {
    addReason(
      reasons,
      `UNREVIEWED_PROVIDER_VERSION: behavior last reviewed through ${CLAUDE_CODE_RULESET.reviewedThrough}`,
    );
  }
  return {
    id: "claude-code",
    version: parsed.version,
    source,
    behaviorRuleset: CLAUDE_CODE_RULESET.id,
    review,
    reviewedThrough: CLAUDE_CODE_RULESET.reviewedThrough,
  };
}

function parseProvider(raw: string | undefined): { version?: string } {
  if (!raw) return {};
  const match = /^(claude-code)(?:@(.+))?$/i.exec(raw.trim());
  if (!match) throw new Error("--provider currently supports only claude-code@<version>");
  const version = match[2]?.trim();
  if (version && !parseVersion(version)) {
    throw new Error(`invalid Claude Code version: ${redactUrls(version)}`);
  }
  return version ? { version: version.replace(/^v/i, "") } : {};
}

async function detectClaudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("claude", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    const match = /\bv?(\d+(?:\.\d+){1,2})\b/.exec(stdout);
    return match && parseVersion(match[1]) ? match[1].replace(/^v/i, "") : undefined;
  } catch {
    return undefined;
  }
}

async function collectWorkspaceFiles(root: string, reasons: string[]): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  const visited = new Set<string>();
  const seenFiles = new Set<string>();

  async function visit(directory: string): Promise<void> {
    let realDirectory: string;
    try {
      realDirectory = await realpath(directory);
    } catch {
      addReason(reasons, `UNREADABLE_DIRECTORY: ${relativePath(root, directory)}`);
      return;
    }
    if (!isInside(root, realDirectory)) {
      addReason(reasons, `EXTERNAL_UNMEASURED: ${relativePath(root, directory)}`);
      return;
    }
    if (visited.has(realDirectory)) return;
    visited.add(realDirectory);

    let entries;
    try {
      entries = await readdir(realDirectory, { withFileTypes: true });
    } catch {
      addReason(reasons, `UNREADABLE_DIRECTORY: ${relativePath(root, realDirectory)}`);
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const candidate = path.join(realDirectory, entry.name);
      let resolved: string;
      try {
        resolved = await realpath(candidate);
      } catch {
        addReason(reasons, `UNREADABLE_ENTRY: ${relativePath(root, candidate)}`);
        continue;
      }
      if (!isInside(root, resolved)) {
        addReason(reasons, `EXTERNAL_UNMEASURED: ${relativePath(root, candidate)}`);
        continue;
      }
      let info;
      try {
        info = await stat(resolved);
      } catch {
        addReason(reasons, `UNREADABLE_ENTRY: ${relativePath(root, candidate)}`);
        continue;
      }
      if (info.isDirectory()) {
        if (!EXCLUDED_DIRS.has(path.basename(resolved))) await visit(resolved);
        continue;
      }
      if (!info.isFile() || seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      files.push({ absPath: resolved, relPath: relativePath(root, resolved), size: info.size });
    }
  }

  await visit(root);
  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

async function collectLoadSurfaces(
  build: AuditBuild,
  root: string,
  files: WorkspaceFile[],
  reasons: string[],
): Promise<void> {
  const rootClaude = files.filter((file) =>
    file.relPath === "CLAUDE.md" || file.relPath === "CLAUDE.local.md",
  );
  const allClaude = files.filter((file) => path.basename(file.relPath).toLowerCase() === "claude.md");
  for (const file of allClaude) {
    addObservation(build, "CLAUDE_MD_BYTES", "file", "CLAUDE.md byte size", file.size, evidence(root, file, undefined, 1, String(file.size)));
    if (file.size > CLAUDE_SKIP_BYTES) {
      addCandidate(build, "SKIPPED_BY_CLAUDE", {
        message: "CLAUDE.md exceeds the modeled 4 MiB load limit",
        evidence: evidence(root, file, undefined, 1, String(file.size)),
      });
    }
  }
  await collectClaudeImports(build, root, rootClaude, reasons);

  let mainBytes = rootClaude.reduce((total, file) => total + file.size, 0);
  const conditionalSurfaces: LoadSurface[] = [];
  const ruleFiles = files.filter((file) => /^\.claude\/rules\/.*\.md$/i.test(file.relPath));
  for (const file of ruleFiles) {
    const content = await readAuditText(root, file, reasons);
    const frontmatter = content ? parseFrontmatter(content) : {};
    const paths = frontmatter.paths;
    if (paths === undefined) {
      mainBytes += file.size;
      addObservation(build, "UNSCOPED_RULE_BYTES", "file", "unscoped Claude rule byte size", file.size, evidence(root, file, undefined, 1, String(file.size)));
    } else {
      const pattern = Array.isArray(paths) ? paths.map(String).join(", ") : String(paths);
      conditionalSurfaces.push({
        id: `path:${pattern || file.relPath}`,
        surface: "conditional",
        rawBytes: file.size,
        measurement: content === undefined ? "partial" : "observed",
      });
    }
  }
  build.surfaces.push({
    id: "main:start",
    surface: "main",
    rawBytes: mainBytes,
    measurement: "observed",
  });
  build.surfaces.push(...conditionalSurfaces);

  const skills = files.filter((file) => /^\.claude\/skills\/.*\/SKILL\.md$/i.test(file.relPath));
  let listingLower = 0;
  let listingUpper = 0;
  for (const file of skills) {
    const content = await readAuditText(root, file, reasons);
    if (content === undefined) continue;
    const frontmatter = parseFrontmatter(content);
    if (frontmatter["disable-model-invocation"] === true) continue;
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : path.basename(path.dirname(file.relPath));
    const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : firstParagraph(content);
    listingLower += Buffer.byteLength(name, "utf8");
    listingUpper += Buffer.byteLength(name, "utf8") + Buffer.byteLength(description, "utf8");
    build.surfaces.push({
      id: `skill:${name}`,
      surface: "skill",
      rawBytes: file.size,
      measurement: "candidate",
    });
  }
  const listingBudget = Math.floor(build.assumedContext * 0.01);
  const main = build.surfaces.find((surface) => surface.id === "main:start");
  if (main) {
    main.listingLower = listingLower;
    main.listingUpper = listingUpper;
    main.overflowAtAssumedContext = listingUpper > listingBudget;
  }
  if (listingUpper > listingBudget) {
    addCandidate(build, "SKILL_LISTING_OVERFLOW", {
      message: `candidate skill listing exceeds the assumed ${build.assumedContext}-token context budget`,
      evidence: rootEvidence(root, `listing:${listingLower}:${listingUpper}:${listingBudget}`),
    });
  }

  const agents = files.filter((file) => /^\.claude\/agents\/.*\.md$/i.test(file.relPath));
  for (const file of agents) {
    build.surfaces.push({
      id: `agent:${path.basename(file.relPath, path.extname(file.relPath))}:startup`,
      surface: "subagent",
      rawBytes: file.size,
      measurement: "candidate",
    });
  }
}

async function collectClaudeImports(
  build: AuditBuild,
  root: string,
  roots: WorkspaceFile[],
  reasons: string[],
): Promise<void> {
  const visited = new Set<string>();
  const surfaced = new Set<string>();

  async function visit(file: WorkspaceFile, depth: number): Promise<void> {
    if (visited.has(file.absPath)) return;
    visited.add(file.absPath);
    if (depth > MAX_IMPORT_HOPS) {
      addReason(reasons, `IMPORT_GRAPH_ANALYSIS_LIMIT: ${file.relPath}`);
      return;
    }
    const content = await readAuditText(root, file, reasons);
    if (content === undefined) return;
    for (const item of extractClaudeImports(content)) {
      const candidate = path.resolve(path.dirname(file.absPath), item.reference);
      let resolved: string;
      try {
        resolved = await realpath(candidate);
      } catch {
        addReason(reasons, `UNRESOLVED_IMPORT: ${file.relPath}:${item.line}`);
        addObservation(
          build,
          "CLAUDE_IMPORT",
          "import",
          "Claude import could not be resolved",
          "unresolved",
          evidence(root, file, undefined, item.line, item.reference),
        );
        continue;
      }
      if (!isInside(root, resolved)) {
        addReason(reasons, `EXTERNAL_UNMEASURED: ${file.relPath}:${item.line}`);
        addObservation(
          build,
          "CLAUDE_IMPORT",
          "import",
          "Claude import resolves outside the workspace",
          "external",
          evidence(root, file, undefined, item.line, item.reference),
        );
        continue;
      }
      let info;
      try {
        info = await stat(resolved);
      } catch {
        addReason(reasons, `UNREADABLE_IMPORT: ${file.relPath}:${item.line}`);
        continue;
      }
      if (!info.isFile()) {
        addReason(reasons, `NON_FILE_IMPORT: ${file.relPath}:${item.line}`);
        continue;
      }
      const imported: WorkspaceFile = {
        absPath: resolved,
        relPath: relativePath(root, resolved),
        size: info.size,
      };
      if (depth + 1 > MAX_IMPORT_HOPS) {
        addReason(reasons, `IMPORT_GRAPH_ANALYSIS_LIMIT: ${file.relPath}`);
        continue;
      }
      addObservation(
        build,
        "CLAUDE_IMPORT",
        "import",
        "Claude import resolves inside the workspace",
        imported.relPath,
        evidence(root, file, undefined, item.line, item.reference),
      );
      if (!surfaced.has(imported.absPath)) {
        surfaced.add(imported.absPath);
        build.surfaces.push({
          id: `main:import:${imported.relPath}`,
          surface: "main",
          rawBytes: imported.size,
          measurement: "observed",
        });
      }
      await visit(imported, depth + 1);
    }
  }

  for (const file of roots) await visit(file, 0);
}

async function collectHooks(
  build: AuditBuild,
  root: string,
  files: WorkspaceFile[],
  reasons: string[],
): Promise<void> {
  const configFiles = files.filter((file) =>
    /^\.claude\/(?:.*\/)?(?:settings(?:\.local)?|hooks)\.json$/i.test(file.relPath),
  );
  for (const file of configFiles) {
    const content = await readAuditText(root, file, reasons);
    if (content === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      addReason(reasons, `UNPARSEABLE_CONFIG: ${file.relPath}`);
      addObservation(build, "CONFIG_PARSE_ERROR", "config", "JSON configuration could not be parsed", true, evidence(root, file, undefined, 1, content));
      continue;
    }
    for (const block of extractHookBlocks(file, parsed)) {
      const matcher = block.matcher ?? "(omitted)";
      addObservation(
        build,
        "HOOK_MATCHER_VALUE",
        "hook",
        "hook matcher declared in configuration",
        matcher,
        evidence(root, file, block.pointer, undefined, JSON.stringify(block.value)),
      );
      if (block.matcher === undefined || block.matcher === "" || block.matcher === "*") {
        addCandidate(build, "MATCH_ALL_HOOK", {
          message: `${block.event} hook matches every occurrence`,
          evidence: evidence(root, file, block.pointer, undefined, JSON.stringify(block.value)),
        });
      }
      for (const handler of block.handlers) {
        if (handler.type !== "http" || !handler.url) continue;
        const remote = isRemoteHttpUrl(handler.url);
        addObservation(
          build,
          "HTTP_HOOK_DECLARED",
          "hook",
          "HTTP hook declared in configuration",
          remote ? "public" : "local-or-invalid",
          evidence(root, file, handler.pointer, undefined, handler.url),
        );
        if (!remote) continue;
        const handlerEvidence = evidence(root, file, handler.pointer, undefined, JSON.stringify(handler));
        addCandidate(build, "REMOTE_HTTP_HOOK", {
          message: "HTTP hook targets a public host",
          evidence: handlerEvidence,
        });
        const headers = Object.entries(handler.headers);
        const interpolated = headers.some(([, value]) =>
          typeof value === "string" && /\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*/.test(value),
        );
        if (interpolated) {
          addCandidate(build, "HEADER_ENV_INTERPOLATION", {
            message: "HTTP hook interpolates an environment variable into a header",
            evidence: handlerEvidence,
          });
        }
        const credentialShaped = headers.some(([name]) =>
          /authorization|token|secret|api[-_]?key|password/i.test(name),
        );
        if (credentialShaped) {
          addCandidate(build, "POTENTIAL_CREDENTIAL_EGRESS", {
            message: "HTTP hook may send a credential-shaped header to a public host",
            evidence: handlerEvidence,
          });
        }
      }
    }
  }
}

function evaluateCandidates(build: AuditBuild): {
  findings: AuditFinding[];
  evaluations: AuditEvaluation[];
} {
  const findings: AuditFinding[] = [];
  const evaluations: AuditEvaluation[] = [];
  for (const rule of CLAUDE_CODE_RULESET.checks) {
    const candidates = build.candidates.get(rule.id) ?? [];
    if (!build.provider.version) {
      evaluations.push({
        id: rule.id,
        dimension: rule.dimension,
        confidence: rule.confidence,
        since: rule.since,
        until: rule.until,
        evaluated: false,
        eligible: false,
        outcome: "unknown-version",
      });
      continue;
    }
    if (!appliesAtVersion(rule, build.provider.version)) {
      addReason(build.coverage.reasons, `NOT_MODELED: ${rule.id} is outside its version window`);
      evaluations.push({
        id: rule.id,
        dimension: rule.dimension,
        confidence: rule.confidence,
        since: rule.since,
        until: rule.until,
        evaluated: false,
        eligible: false,
        outcome: "not-modeled",
      });
      continue;
    }
    const eligible = build.provider.review === "reviewed" && rule.confidence === "deterministic";
    evaluations.push({
      id: rule.id,
      dimension: rule.dimension,
      confidence: rule.confidence,
      since: rule.since,
      until: rule.until,
      evaluated: true,
      eligible,
      outcome: candidates.length > 0 ? "finding" : "clean",
    });
    for (const candidate of candidates) {
      findings.push({
        id: rule.id,
        dimension: rule.dimension,
        confidence: rule.confidence,
        surface: surfaceFor(rule.dimension),
        severity: rule.severity,
        ci: { eligible, defaultFail: rule.defaultFail },
        message: candidate.message,
        evidence: candidate.evidence,
      });
    }
  }
  build.coverage.status = build.coverage.reasons.length === 0 ? "FULL" : "PARTIAL";
  return { findings, evaluations };
}

function suppressedForReviewExpiry(
  result: Pick<AuditResult, "provider" | "findings">,
  options: AuditOptions,
): SuppressedEvaluation[] {
  if (result.provider.review !== "unreviewed" || options.failOnUnreviewed) return [];
  const selectors = options.failOn ?? [];
  return result.findings
    .filter((finding) => finding.confidence === "deterministic")
    .filter((finding) =>
      finding.ci.defaultFail || (selectors.length > 0 && matchesSelector(finding.id, finding.dimension, selectors)),
    )
    .map((finding) => ({
      id: finding.id,
      reason: "would have failed under reviewed policy",
      evidence: finding.evidence,
    }));
}

function isEligibleFinding(
  finding: AuditFinding,
  provider: AuditProvider,
  options: AuditOptions,
): boolean {
  if (finding.confidence !== "deterministic") return false;
  return finding.ci.eligible || (provider.review === "unreviewed" && options.failOnUnreviewed === true);
}

function isEligibleEvaluation(
  evaluation: AuditEvaluation,
  provider: AuditProvider,
  options: AuditOptions,
): boolean {
  if (evaluation.confidence !== "deterministic") return false;
  return evaluation.eligible || (
    evaluation.evaluated &&
    provider.review === "unreviewed" &&
    options.failOnUnreviewed === true
  );
}

function matchesSelector(id: string, dimension: AuditSurface | string, selectors: string[]): boolean {
  return selectors.some((selector) => selector === id || selector === dimension);
}

function surfaceFor(dimension: string): AuditSurface {
  if (dimension === "context") return "main";
  return "main";
}

function extractHookBlocks(file: WorkspaceFile, value: unknown): HookBlock[] {
  if (!isRecord(value) || !isRecord(value.hooks)) return [];
  const blocks: HookBlock[] = [];
  for (const [event, rawBlocks] of Object.entries(value.hooks)) {
    if (!Array.isArray(rawBlocks)) continue;
    for (let index = 0; index < rawBlocks.length; index += 1) {
      const rawBlock = rawBlocks[index];
      if (!isRecord(rawBlock)) continue;
      const pointer = `/hooks/${escapePointer(event)}/${index}`;
      const rawHandlers = Array.isArray(rawBlock.hooks) ? rawBlock.hooks : [];
      const handlers = rawHandlers.flatMap((rawHandler, handlerIndex) => {
        if (!isRecord(rawHandler)) return [];
        const headers = isRecord(rawHandler.headers) ? rawHandler.headers : {};
        const type = typeof rawHandler.type === "string" ? rawHandler.type.toLowerCase() : "command";
        const url = typeof rawHandler.url === "string" ? rawHandler.url : undefined;
        return [{ type, url, headers, pointer: `${pointer}/hooks/${handlerIndex}` }];
      });
      blocks.push({
        file,
        event,
        matcher: typeof rawBlock.matcher === "string" ? rawBlock.matcher : undefined,
        pointer,
        handlers,
        value: rawBlock,
      });
    }
  }
  return blocks;
}

async function readAuditText(
  root: string,
  file: WorkspaceFile,
  reasons: string[],
): Promise<string | undefined> {
  if (file.size > MAX_AUDIT_READ_BYTES) {
    addReason(reasons, `UNMEASURED_FILE_TOO_LARGE: ${file.relPath}`);
    return undefined;
  }
  let handle;
  try {
    handle = await open(file.absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile()) {
      addReason(reasons, `ENTRY_CHANGED_BEFORE_READ: ${file.relPath}`);
      return undefined;
    }
    if (current.size > MAX_AUDIT_READ_BYTES) {
      addReason(reasons, `UNMEASURED_FILE_TOO_LARGE: ${file.relPath}`);
      return undefined;
    }
    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    addReason(reasons, `UNREADABLE_FILE: ${relativePath(root, file.absPath)}`);
    return undefined;
  } finally {
    await handle?.close();
  }
}

function isRemoteHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

function isPrivateHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return /^f[cd][0-9a-f:]+$/i.test(host) || /^fe[89ab][0-9a-f:]+$/i.test(host);
  }
  const [first, second] = parts;
  return first === 10 ||
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127);
}

function firstParagraph(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return body.split(/\r?\n\s*\r?\n/, 1)[0]?.trim() ?? "";
}

function extractClaudeImports(content: string): Array<{ reference: string; line: number }> {
  const imports: Array<{ reference: string; line: number }> = [];
  let inFence = false;
  const lines = content.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /<!--/.test(line) || /-->/.test(line)) continue;
    const match = /^\s*@(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(line);
    const reference = match?.[1] ?? match?.[2] ?? match?.[3];
    if (reference) imports.push({ reference, line: index + 1 });
  }
  return imports;
}

function addCandidate(build: AuditBuild, id: string, candidate: Candidate): void {
  const current = build.candidates.get(id);
  if (current) current.push(candidate);
  else build.candidates.set(id, [candidate]);
}

function addObservation(
  build: AuditBuild,
  id: string,
  kind: string,
  message: string,
  value: string | number | boolean,
  itemEvidence: AuditEvidence,
): void {
  build.observations.push({ id, kind, message, value, evidence: itemEvidence });
}

function evidence(
  root: string,
  file: WorkspaceFile,
  pointer: string | undefined,
  line: number | undefined,
  value: string,
): AuditEvidence {
  return {
    path: relativePath(root, file.absPath),
    ...(pointer ? { pointer } : {}),
    ...(line ? { line } : {}),
    valueHash: hash(value),
  };
}

function rootEvidence(root: string, value: string): AuditEvidence {
  return { path: ".", valueHash: hash(`${root}:${value}`) };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function relativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return redactUrls(toPosix(relative || "."));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
