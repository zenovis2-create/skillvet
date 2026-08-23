import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { parseFrontmatter } from "./manifest.js";
import { isBlockedAddress, redactTarget } from "./safe-http.js";
import { discoverDirectSkills } from "./skill-collection.js";
import {
  VERSION,
  type CodexAuditEvidence,
  type CodexAuditFinding,
  type CodexAuditObservation,
  type CodexAuditOptions,
  type CodexAuditResult,
  type CodexInstructionConfiguration,
  type CodexMcpServer,
  type CodexPlugin,
  type CodexSkillInventoryItem,
} from "./types.js";
import { redactUrls, toPosix } from "./walk.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_MANIFEST_BYTES = 2 * 1024 * 1024;

interface TomlValue {
  value: unknown;
  raw: string;
  line: number;
}

interface TomlTable {
  path: string[];
  array: boolean;
  line: number;
  source: string;
  values: Map<string, TomlValue>;
}

interface ParsedToml {
  tables: TomlTable[];
  reasons: string[];
}

interface SkillOverride {
  path?: string;
  enabled?: boolean;
  line: number;
  source: string;
  value: string;
}

export async function auditCodex(
  target: string,
  options: CodexAuditOptions = {},
): Promise<CodexAuditResult> {
  const root = await resolveCodexHome(target);
  const configPath = path.join(root, "config.toml");
  const config = await readUtf8(configPath, MAX_CONFIG_BYTES, "Codex config");
  const parsed = parseToml(config, "config.toml");
  const profile = await readProfile(root, options.profile);
  const tables = mergeTomlTables([...parsed.tables, ...(profile?.parsed.tables ?? [])]);
  const reasons = [...parsed.reasons, ...(profile?.parsed.reasons ?? [])];
  const observations: CodexAuditObservation[] = [];
  const findings: CodexAuditFinding[] = [];

  const overrides = [
    ...collectSkillOverrides(parsed.tables, observations, findings),
    ...(profile ? collectSkillOverrides(profile.parsed.tables, observations, findings) : []),
  ];
  const skills = await collectSkills(root, overrides, reasons, observations);
  await collectOverridePathFindings(root, overrides, findings, observations, reasons);
  const mcpServers = collectMcpServers(tables, observations, findings);
  const plugins = collectPlugins(tables, observations, findings);
  const instructions = await collectInstructionConfiguration(
    root,
    tables,
    observations,
    findings,
    reasons,
  );

  const discovered = skills.length;
  const enabled = skills.filter((skill) => skill.enabled).length;
  const disabled = discovered - enabled;
  const links = skills.filter((skill) => skill.link).length;
  const listingBytes = skills
    .filter((skill) => skill.enabled)
    .reduce((total, skill) => total + (skill.listingBytes ?? 0), 0);
  addObservation(
    observations,
    "CODEX_SKILL_CATALOGUE",
    "direct local skills discovered by the Codex loader surface",
    discovered,
    evidence("skills", String(discovered)),
  );
  addObservation(
    observations,
    "CODEX_SKILL_LISTING_BYTES",
    "enabled skill discovery metadata bytes (not a token estimate)",
    listingBytes,
    evidence("skills", `listing:${enabled}:${listingBytes}`),
  );

  const coverage = {
    status: reasons.length === 0 ? "FULL" as const : "PARTIAL" as const,
    reasons,
  };
  const status = codexAuditStatus(findings, coverage.status);
  return {
    version: VERSION,
    target: redactUrls(redactTarget(target)),
    configPath: redactUrls(configPath),
    ...(profile ? { profile: { name: profile.name, configPath: redactUrls(profile.path) } } : {}),
    status,
    coverage,
    catalogue: { discovered, enabled, disabled, links, listingBytes },
    skills,
    mcpServers,
    plugins,
    instructions,
    observations,
    findings,
  };
}

export function codexAuditExitCode(
  result: Pick<CodexAuditResult, "findings" | "coverage">,
): 0 | 2 | 3 {
  if (result.findings.some((finding) => finding.severity === "high")) return 2;
  return result.coverage.status === "PARTIAL" ? 3 : 0;
}

function codexAuditStatus(
  findings: CodexAuditFinding[],
  coverage: CodexAuditResult["coverage"]["status"],
): CodexAuditResult["status"] {
  if (findings.some((finding) => finding.severity === "high")) return "FAIL";
  return coverage === "PARTIAL" ? "DEGRADED" : "PASS";
}

async function resolveCodexHome(target: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new Error("Codex audit accepts a local CODEX_HOME directory, not a URL");
  }
  const candidate = path.resolve(target);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error(`Codex home path not found: ${redactUrls(target)}`);
  }
  if (!info.isDirectory()) throw new Error(`Codex home path is not a directory: ${redactUrls(target)}`);
  return realpath(candidate);
}

async function readProfile(
  root: string,
  name: string | undefined,
): Promise<{ name: string; path: string; parsed: ParsedToml } | undefined> {
  if (!name) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Codex profile name may contain only letters, numbers, underscores, and hyphens");
  }
  const profilePath = path.join(root, `${name}.config.toml`);
  const content = await readUtf8(profilePath, MAX_CONFIG_BYTES, "Codex profile config");
  return { name, path: profilePath, parsed: parseToml(content, `${name}.config.toml`) };
}

function mergeTomlTables(tables: TomlTable[]): TomlTable[] {
  const merged: TomlTable[] = [];
  const locations = new Map<string, number>();
  for (const table of tables) {
    if (table.array) {
      merged.push(table);
      continue;
    }
    const key = table.path.join("\u0000");
    const existing = locations.get(key);
    if (existing === undefined) {
      locations.set(key, merged.length);
      merged.push(table);
      continue;
    }
    const previous = merged[existing];
    if (!previous) continue;
    merged[existing] = {
      ...table,
      values: new Map([...previous.values, ...table.values]),
    };
  }
  return merged;
}

async function collectSkills(
  root: string,
  overrides: SkillOverride[],
  reasons: string[],
  observations: CodexAuditObservation[],
): Promise<CodexSkillInventoryItem[]> {
  const skillsRoot = path.join(root, "skills");
  let discovery;
  try {
    discovery = await discoverDirectSkills(skillsRoot);
  } catch {
    addReason(reasons, "UNREADABLE_SKILLS_DIRECTORY: skills");
    return [];
  }
  for (const skipped of discovery.skipped) {
    addReason(reasons, `UNINSPECTED_SKILL_ENTRY: ${skipped.relPath}`);
  }

  const overridePaths = new Map<string, SkillOverride[]>();
  for (const override of overrides) {
    if (!override.path) continue;
    const key = normalizedPath(path.isAbsolute(override.path) ? override.path : path.resolve(root, override.path));
    const current = overridePaths.get(key);
    if (current) current.push(override);
    else overridePaths.set(key, [override]);
  }

  const result: CodexSkillInventoryItem[] = [];
  for (const skill of discovery.skills) {
    const manifest = path.join(skill.path, "SKILL.md");
    const candidates = [normalizedPath(manifest)];
    try {
      candidates.push(normalizedPath(await realpath(manifest)));
    } catch {
      addReason(reasons, `UNRESOLVED_SKILL_MANIFEST: ${skill.name}`);
    }
    const applied = candidates.flatMap((candidate) => overridePaths.get(candidate) ?? []);
    const effectiveOverride = [...applied].reverse().find((override) => override.enabled !== undefined);
    const enabled = effectiveOverride?.enabled ?? true;
    const listingBytes = await listingMetadataBytes(manifest, skill.name, reasons);
    result.push({
      name: skill.name,
      manifestPath: relativePath(root, manifest),
      link: skill.link,
      enabled,
      ...(listingBytes === undefined ? {} : { listingBytes }),
    });
  }
  addObservation(
    observations,
    "CODEX_SKILL_LINKS",
    "direct skill entries reached through filesystem links or junctions",
    result.filter((skill) => skill.link).length,
    evidence("skills", `links:${result.filter((skill) => skill.link).length}`),
  );
  return result;
}

async function listingMetadataBytes(
  manifest: string,
  fallbackName: string,
  reasons: string[],
): Promise<number | undefined> {
  let content: string;
  try {
    content = await readUtf8(manifest, MAX_SKILL_MANIFEST_BYTES, "skill manifest");
  } catch {
    addReason(reasons, `UNREADABLE_SKILL_MANIFEST: ${fallbackName}`);
    return undefined;
  }
  const frontmatter = parseFrontmatter(content);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : fallbackName;
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : "";
  return Buffer.byteLength(name, "utf8") + Buffer.byteLength(description, "utf8");
}

function collectSkillOverrides(
  tables: TomlTable[],
  observations: CodexAuditObservation[],
  findings: CodexAuditFinding[],
): SkillOverride[] {
  const overrides: SkillOverride[] = [];
  for (const table of tables.filter((candidate) =>
    candidate.array && equalPath(candidate.path, ["skills", "config"]))) {
    const pathValue = table.values.get("path");
    const enabledValue = table.values.get("enabled");
    const override: SkillOverride = {
      path: typeof pathValue?.value === "string" ? pathValue.value : undefined,
      enabled: typeof enabledValue?.value === "boolean" ? enabledValue.value : undefined,
      line: table.line,
      source: table.source,
      value: JSON.stringify([...table.values.entries()].map(([key, value]) => [key, value.raw])),
    };
    overrides.push(override);
    if (!override.path) {
      findings.push({
        id: "MALFORMED_SKILL_OVERRIDE",
        severity: "high",
        message: "skills.config entry has no string path",
        evidence: evidence(table.source, override.value, table.line),
      });
      continue;
    }
    addObservation(
      observations,
      "CODEX_SKILL_OVERRIDE",
      "skills.config override declared",
      override.enabled ?? "unspecified",
      evidence(table.source, override.value, table.line),
    );
  }

  const grouped = new Map<string, SkillOverride[]>();
  for (const override of overrides) {
    if (!override.path) continue;
    const key = normalizedPath(override.path);
    const values = grouped.get(key);
    if (values) values.push(override);
    else grouped.set(key, [override]);
  }
  for (const values of grouped.values()) {
    const states = new Set(values.map((value) => value.enabled).filter((value) => value !== undefined));
    if (states.size > 1) {
      findings.push({
        id: "CONFLICTING_SKILL_OVERRIDE",
        severity: "high",
        message: "the same skills.config path is declared with conflicting enabled states",
        evidence: evidence(values[0]?.source ?? "config.toml", values.map((value) => value.value).join("\n"), values[0]?.line),
      });
    }
  }
  return overrides;
}

async function collectOverridePathFindings(
  root: string,
  overrides: SkillOverride[],
  findings: CodexAuditFinding[],
  observations: CodexAuditObservation[],
  reasons: string[],
): Promise<void> {
  for (const override of overrides) {
    if (!override.path) continue;
    const candidate = path.isAbsolute(override.path) ? override.path : path.resolve(root, override.path);
    let info;
    try {
      info = await stat(candidate);
    } catch {
      findings.push({
        id: "UNRESOLVED_SKILL_OVERRIDE",
        severity: "high",
        message: "skills.config points to a path that does not exist",
        evidence: evidence(override.source, override.value, override.line),
      });
      continue;
    }
    if (!info.isFile() || path.basename(candidate).toLowerCase() !== "skill.md") {
      addObservation(
        observations,
        "NON_MANIFEST_SKILL_OVERRIDE",
        "skills.config path is not a SKILL.md file; verify loader behavior for this Codex version",
        info.isDirectory() ? "directory" : "non-file",
        evidence(override.source, override.value, override.line),
      );
    }
    if (info.isDirectory()) {
      addReason(reasons, `DIRECTORY_SKILL_OVERRIDE: config.toml:${override.line}`);
    }
  }
}

async function collectInstructionConfiguration(
  root: string,
  tables: TomlTable[],
  observations: CodexAuditObservation[],
  findings: CodexAuditFinding[],
  reasons: string[],
): Promise<CodexInstructionConfiguration> {
  const [agents, override] = await Promise.all([
    inspectInstructionFile(root, "AGENTS.md", reasons),
    inspectInstructionFile(root, "AGENTS.override.md", reasons),
  ]);
  const global: CodexInstructionConfiguration["global"] = {
    ...(agents ? { agents } : {}),
    ...(override ? { override } : {}),
    ...(override && override.bytes > 0
      ? { effective: "AGENTS.override.md" as const }
      : agents && agents.bytes > 0
        ? { effective: "AGENTS.md" as const }
        : {}),
  };
  for (const item of [agents, override]) {
    if (!item) continue;
    addObservation(
      observations,
      "CODEX_GLOBAL_INSTRUCTION_BYTES",
      "Codex global instruction file byte size",
      item.bytes,
      evidence(item.path, String(item.bytes)),
    );
  }
  if (agents && agents.bytes > 0 && override && override.bytes > 0) {
    findings.push({
      id: "CODEX_GLOBAL_OVERRIDE_REPLACES_AGENTS",
      severity: "warning",
      message: "AGENTS.override.md replaces AGENTS.md in the Codex home; review the override for every required rule",
      evidence: evidence("AGENTS.override.md", agents.path),
    });
  }

  const rootTable = tables.find((table) => table.path.length === 0);
  const configuredLimit = rootTable?.values.get("project_doc_max_bytes");
  const projectDocMaxBytes = typeof configuredLimit?.value === "number"
    && Number.isInteger(configuredLimit.value)
    && configuredLimit.value > 0
    ? configuredLimit.value
    : undefined;
  if (projectDocMaxBytes !== undefined) {
    addObservation(
      observations,
      "CODEX_PROJECT_DOC_MAX_BYTES",
      "configured Codex project instruction byte limit",
      projectDocMaxBytes,
      evidence(rootTable?.source ?? "config.toml", String(projectDocMaxBytes), configuredLimit?.line),
    );
  } else if (configuredLimit) {
    findings.push({
      id: "INVALID_PROJECT_DOC_MAX_BYTES",
      severity: "warning",
      message: "project_doc_max_bytes is not a positive integer",
      evidence: evidence(rootTable?.source ?? "config.toml", configuredLimit.raw, configuredLimit.line),
    });
  }
  return { global, ...(projectDocMaxBytes === undefined ? {} : { projectDocMaxBytes }) };
}

async function inspectInstructionFile(
  root: string,
  name: "AGENTS.md" | "AGENTS.override.md",
  reasons: string[],
): Promise<{ path: string; bytes: number } | undefined> {
  const candidate = path.join(root, name);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    return undefined;
  }
  if (!info.isFile()) {
    addReason(reasons, `NON_FILE_GLOBAL_INSTRUCTION: ${name}`);
    return undefined;
  }
  return { path: name, bytes: info.size };
}

function collectMcpServers(
  tables: TomlTable[],
  observations: CodexAuditObservation[],
  findings: CodexAuditFinding[],
): CodexMcpServer[] {
  const servers: CodexMcpServer[] = [];
  for (const table of tables.filter((candidate) =>
    candidate.path[0] === "mcp_servers" && candidate.path.length === 2)) {
    const command = table.values.get("command")?.value;
    const url = table.values.get("url")?.value;
    const transport = typeof command === "string" ? "command" : typeof url === "string" ? "url" : "unknown";
    const endpointScope = typeof url === "string" ? endpointScopeFor(url) : "unknown";
    const server: CodexMcpServer = {
      name: table.path[1] ?? "unknown",
      transport,
      endpointScope,
      line: table.line,
    };
    servers.push(server);
    addObservation(
      observations,
      "CODEX_MCP_SERVER",
      "MCP server declared in config.toml",
      `${transport}:${endpointScope}`,
      evidence(table.source, JSON.stringify([table.path, command, url]), table.line),
    );
    if (transport === "url" && endpointScope === "public") {
      findings.push({
        id: "PUBLIC_MCP_ENDPOINT",
        severity: "warning",
        message: "MCP server is configured with a public HTTP(S) endpoint",
        evidence: evidence(table.source, String(url), table.line),
      });
    }
  }
  return servers.sort((left, right) => left.name.localeCompare(right.name));
}

function collectPlugins(
  tables: TomlTable[],
  observations: CodexAuditObservation[],
  findings: CodexAuditFinding[],
): CodexPlugin[] {
  const ids = new Set(
    tables
      .filter((table) => table.path[0] === "plugins" && table.path.length >= 2)
      .map((table) => table.path[1] ?? ""),
  );
  const plugins: CodexPlugin[] = [];
  for (const id of ids) {
    if (!id) continue;
    const base = tables.find((table) => equalPath(table.path, ["plugins", id]));
    const rawEnabled = base?.values.get("enabled")?.value;
    const enabled = typeof rawEnabled === "boolean" ? rawEnabled : "unspecified";
    const children = tables.filter((table) =>
      table.path[0] === "plugins" && table.path[1] === id && table.path.length > 2 && table.values.size > 0);
    const trustedHookStates = tables.filter((table) =>
      table.path[0] === "hooks" && table.path[1] === "state" && (table.path[2] ?? "").startsWith(`${id}:`)).length;
    const plugin: CodexPlugin = {
      id,
      enabled,
      childSettings: children.length,
      trustedHookStates,
      line: base?.line ?? children[0]?.line ?? 1,
    };
    plugins.push(plugin);
    addObservation(
      observations,
      "CODEX_PLUGIN",
      "plugin configuration declared",
      enabled,
      evidence(base?.source ?? children[0]?.source ?? "config.toml", JSON.stringify(plugin), plugin.line),
    );
    if (enabled === false && (plugin.childSettings > 0 || plugin.trustedHookStates > 0)) {
      findings.push({
        id: "INACTIVE_PLUGIN_CONFIGURATION",
        severity: "warning",
        message: `disabled plugin retains ${plugin.childSettings} child settings and ${plugin.trustedHookStates} trusted hook states`,
        evidence: evidence(base?.source ?? children[0]?.source ?? "config.toml", JSON.stringify(plugin), plugin.line),
      });
    }
  }
  return plugins.sort((left, right) => left.id.localeCompare(right.id));
}

function endpointScopeFor(raw: string): CodexMcpServer["endpointScope"] {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return "local";
    return isIP(host) !== 0 && isBlockedAddress(host) ? "local" : "public";
  } catch {
    return "unknown";
  }
}

function parseToml(content: string, source: string): ParsedToml {
  const tables: TomlTable[] = [{ path: [], array: false, line: 1, source, values: new Map() }];
  const reasons: string[] = [];
  let current = tables[0];
  for (const [index, rawLine] of content.split(/\r\n|\r|\n/).entries()) {
    const lineNo = index + 1;
    const line = stripTomlComment(rawLine ?? "").trim();
    if (!line) continue;
    const arrayHeader = line.startsWith("[[") && line.endsWith("]]" );
    const tableHeader = !arrayHeader && line.startsWith("[") && line.endsWith("]");
    if (arrayHeader || tableHeader) {
      const body = arrayHeader ? line.slice(2, -2) : line.slice(1, -1);
      const tablePath = parseTomlPath(body);
      if (!tablePath || tablePath.length === 0) {
        addReason(reasons, `UNPARSEABLE_TOML_HEADER: ${source}:${lineNo}`);
        continue;
      }
      current = { path: tablePath, array: arrayHeader, line: lineNo, source, values: new Map() };
      tables.push(current);
      continue;
    }
    const assignment = /^(.+?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      addReason(reasons, `UNPARSEABLE_TOML_LINE: ${source}:${lineNo}`);
      continue;
    }
    const keyPath = parseTomlPath(assignment[1] ?? "");
    const key = keyPath?.join(".");
    if (!key) {
      addReason(reasons, `UNPARSEABLE_TOML_KEY: ${source}:${lineNo}`);
      continue;
    }
    const rawValue = assignment[2]?.trim() ?? "";
    current.values.set(key, { value: parseTomlValue(rawValue), raw: rawValue, line: lineNo });
  }
  return { tables, reasons };
}

function stripTomlComment(input: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote === '"' && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === quote && !escaped) quote = undefined;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (!quote && char === "#") return input.slice(0, index);
    escaped = false;
  }
  return input;
}

function parseTomlPath(input: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    const value = current.trim();
    if (!value) return false;
    parts.push(value);
    current = "";
    return true;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = undefined;
        continue;
      }
      current += char;
      escaped = false;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ".") {
      if (!push()) return undefined;
      continue;
    }
    current += char;
  }
  if (quote || !push()) return undefined;
  return parts;
}

function parseTomlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

async function readUtf8(file: string, maxBytes: number, label: string): Promise<string> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`${label} was not found: ${redactUrls(file)}`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${redactUrls(file)}`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const content = await readFile(file);
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function normalizedPath(value: string): string {
  return path.normalize(path.resolve(value)).replace(/\\/g, "/").toLowerCase();
}

function equalPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function relativePath(root: string, candidate: string): string {
  return redactUrls(toPosix(path.relative(root, candidate) || "."));
}

function addObservation(
  observations: CodexAuditObservation[],
  id: string,
  message: string,
  value: string | number | boolean,
  itemEvidence: CodexAuditEvidence,
): void {
  observations.push({ id, message, value, evidence: itemEvidence });
}

function evidence(pathname: string, value: string, line?: number): CodexAuditEvidence {
  return {
    path: redactUrls(pathname),
    ...(line ? { line } : {}),
    valueHash: createHash("sha256").update(value).digest("hex"),
  };
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
