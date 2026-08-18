import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpManifest, PackageJson, SkillManifest } from "./types.js";

export function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  return parseSimpleYaml(match[1]);
}

export function parseSimpleYaml(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArr: string[] | null = null;

  for (const raw of src.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const listItem = raw.match(/^\s+-\s+(.+)$/);
    if (listItem && currentKey) {
      if (!currentArr) {
        currentArr = [];
        result[currentKey] = currentArr;
      }
      currentArr.push(stripQuotes(listItem[1] ?? ""));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    currentKey = (kv[1] ?? "").toLowerCase();
    currentArr = null;
    const value = (kv[2] ?? "").trim();
    if (value === "") {
      currentArr = [];
      result[currentKey] = currentArr;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[currentKey] = value
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
    } else {
      result[currentKey] = stripQuotes(value);
    }
  }
  return result;
}

export function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function hostFromUrl(raw: string): string | undefined {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    return normalizeHost(url.hostname);
  } catch {
    return undefined;
  }
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

export function domainsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => domainsFromUnknown(v));
  }
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => hostFromUrl(s) ?? normalizeHost(s))
    .filter(Boolean);
}

export function parseSkillMarkdown(md: string): SkillManifest {
  const fm = parseFrontmatter(md);
  const allowed = [
    ...domainsFromUnknown(fm["allowed-domains"]),
    ...domainsFromUnknown(fm["alloweddomains"]),
    ...domainsFromUnknown(fm["allowed-hosts"]),
    ...domainsFromUnknown(fm["homepage"]),
  ];
  const name = typeof fm.name === "string" ? fm.name.trim() : undefined;
  const description =
    typeof fm.description === "string" ? fm.description.trim() : undefined;
  return {
    name: name || undefined,
    description: description || undefined,
    allowedDomains: unique(allowed),
    rawFrontmatter: Object.keys(fm).length > 0,
  };
}

export function allowedDomainsFromPackage(pkg: PackageJson): string[] {
  const extra = (pkg as PackageJson & { skillvet?: { allowedDomains?: unknown } })
    .skillvet?.allowedDomains;
  const repo =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return unique([
    ...domainsFromUnknown(pkg.homepage),
    ...domainsFromUnknown(repo),
    ...domainsFromUnknown(extra),
  ]);
}

export function parseMcpJson(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj.servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return Object.keys(servers).length > 0;
  }
  return false;
}

export function packageLooksLikeMcp(pkg: PackageJson): boolean {
  return pkg.mcp !== undefined || pkg.mcpServers !== undefined || Boolean(pkg.mcpName);
}

export async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function loadPackageJson(root: string): Promise<PackageJson | undefined> {
  const raw = await readJsonIfExists(path.join(root, "package.json"));
  if (!raw || typeof raw !== "object") return undefined;
  return raw as PackageJson;
}

export async function loadSkillManifest(root: string): Promise<SkillManifest | undefined> {
  try {
    const md = await readFile(path.join(root, "SKILL.md"), "utf8");
    return parseSkillMarkdown(md);
  } catch {
    return undefined;
  }
}

export async function loadMcpManifest(
  root: string,
  pkg?: PackageJson,
): Promise<McpManifest | undefined> {
  const mcpRaw = await readJsonIfExists(path.join(root, "mcp.json"));
  if (mcpRaw !== undefined) {
    return { valid: parseMcpJson(mcpRaw), source: "mcp.json" };
  }
  if (pkg && packageLooksLikeMcp(pkg)) {
    return { valid: true, source: "package.json" };
  }
  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
