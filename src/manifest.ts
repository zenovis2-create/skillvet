import { open } from "node:fs/promises";
import path from "node:path";
import type { McpManifest, PackageJson, SkillManifest } from "./types.js";
import { MAX_TEXT_BYTES } from "./walk.js";

export function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  return parseSimpleYaml(match[1]);
}

export function parseSimpleYaml(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArr: string[] | null = null;

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
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
    const blockStyle = value.match(/^([|>])[+-]?$/)?.[1];
    if (value === "") {
      currentArr = [];
      result[currentKey] = currentArr;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[currentKey] = value
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
    } else if (blockStyle) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(?:\s+|$)/.test(lines[i + 1] ?? "")) {
        i += 1;
        block.push((lines[i] ?? "").replace(/^\s+/, ""));
      }
      result[currentKey] = (blockStyle === "|" ? block.join("\n") : block.join(" ")).trim();
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

export function parseMcpJson(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const obj = raw;
  const servers = obj.mcpServers ?? obj.servers;
  if (isRecord(servers)) {
    const entries = Object.values(servers);
    return entries.length > 0 && entries.every(isMcpServerConfig);
  }
  return false;
}

export function parseServerJson(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const server = raw;
  return Boolean(
    typeof server.name === "string" &&
      server.name.length >= 3 &&
      server.name.length <= 200 &&
      /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(server.name) &&
      typeof server.description === "string" &&
      server.description.trim() &&
      server.description.length <= 100 &&
      typeof server.version === "string" &&
      server.version.trim() &&
      server.version.length <= 255,
  );
}

export function packageMcpValidity(pkg: PackageJson): boolean | undefined {
  if (pkg.mcpServers !== undefined) {
    return parseMcpJson({ mcpServers: pkg.mcpServers });
  }
  if (pkg.mcp !== undefined) {
    const value = pkg.mcp;
    if (isRecord(value)) {
      return parseMcpJson(value) || isMcpServerConfig(value);
    }
    return false;
  }
  if (pkg.mcpName !== undefined) return false;
  return undefined;
}

export async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    const text = await readUtf8IfSmall(file);
    if (text === undefined) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function loadPackageJson(root: string): Promise<PackageJson | undefined> {
  const raw = await readJsonIfExists(path.join(root, "package.json"));
  if (!isRecord(raw)) return undefined;
  return raw;
}

export async function loadSkillManifest(root: string): Promise<SkillManifest | undefined> {
  try {
    const md = await readUtf8IfSmall(path.join(root, "SKILL.md"));
    if (md === undefined) return undefined;
    return parseSkillMarkdown(md);
  } catch {
    return undefined;
  }
}

export async function loadMcpManifest(
  root: string,
  pkg?: PackageJson,
): Promise<McpManifest | undefined> {
  const serverRaw = await readJsonIfExists(path.join(root, "server.json"));
  if (serverRaw !== undefined) {
    return { valid: parseServerJson(serverRaw), source: "server.json" };
  }
  const mcpRaw = await readJsonIfExists(path.join(root, "mcp.json"));
  if (mcpRaw !== undefined) {
    return { valid: parseMcpJson(mcpRaw), source: "mcp.json" };
  }
  if (pkg) {
    const valid = packageMcpValidity(pkg);
    if (valid !== undefined) return { valid, source: "package.json" };
  }
  return undefined;
}

function isMcpServerConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const config = value;
  return Boolean(
    (typeof config.command === "string" && config.command.trim()) ||
      (typeof config.url === "string" && /^https?:\/\//i.test(config.url)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readUtf8IfSmall(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TEXT_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
