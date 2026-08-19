import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseDocument, visit } from "yaml";
import type { McpManifest, PackageJson, SkillManifest } from "./types.js";
import { MAX_TEXT_BYTES } from "./walk.js";

export function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  return parseSimpleYaml(match[1]);
}

export function parseSimpleYaml(src: string): Record<string, unknown> {
  if (!isYamlPrintable(src)) return { "skillvet.invalid-yaml": null };
  try {
    const document = parseDocument(src, {
      merge: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    let unsupportedTag = false;
    visit(document, {
      Node(_key, node) {
        if (node.tag && !YAML_CORE_TAGS.has(node.tag)) {
          unsupportedTag = true;
          return visit.BREAK;
        }
      },
    });
    if (document.errors.length > 0 || document.warnings.length > 0 || unsupportedTag) {
      return { "skillvet.invalid-yaml": null };
    }
    const parsed: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 20 });
    const normalized = normalizeYamlMaps(parsed);
    return isRecord(normalized) ? normalized : { "skillvet.invalid-yaml": null };
  } catch {
    return { "skillvet.invalid-yaml": null };
  }
}

function isYamlPrintable(src: string): boolean {
  for (const char of src) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return false;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      codePoint === 0x85 ||
      (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

const YAML_CORE_TAGS = new Set([
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
]);

function normalizeYamlMaps(value: unknown, stack = new WeakSet<object>()): unknown {
  if (value instanceof Map) {
    if (stack.has(value)) return { "skillvet.invalid-yaml": null };
    stack.add(value);
    const entries: Array<[string, unknown]> = [];
    for (const [key, child] of value) {
      if (typeof key !== "string") {
        stack.delete(value);
        return { "skillvet.invalid-yaml": null };
      }
      entries.push([key, normalizeYamlMaps(child, stack)]);
    }
    stack.delete(value);
    return Object.fromEntries(entries);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) return [{ "skillvet.invalid-yaml": null }];
    stack.add(value);
    const result = value.map((child) => normalizeYamlMaps(child, stack));
    stack.delete(value);
    return result;
  }
  return value;
}

export function hostFromUrl(raw: string): string | undefined {
  try {
    const withScheme = /^(?:https?|wss?):/i.test(raw) ? raw : `https://${raw}`;
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
  const supportedFields = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);
  const metadata = fm.metadata;
  const metadataValid =
    metadata === undefined ||
    (isRecord(metadata) && Object.values(metadata).every((value) => typeof value === "string"));
  const invalidFields: string[] = [];
  if (fm.license !== undefined && typeof fm.license !== "string") {
    invalidFields.push("license");
  }
  if (
    fm.compatibility !== undefined &&
    (typeof fm.compatibility !== "string" ||
      fm.compatibility.length < 1 ||
      fm.compatibility.length > 500)
  ) {
    invalidFields.push("compatibility");
  }
  if (fm["allowed-tools"] !== undefined && typeof fm["allowed-tools"] !== "string") {
    invalidFields.push("allowed-tools");
  }
  const allowed = metadataValid && isRecord(metadata)
    ? domainsFromUnknown(metadata["skillvet.allowed-domains"])
    : [];
  const name = typeof fm.name === "string" ? fm.name.trim() : undefined;
  const description =
    typeof fm.description === "string" ? fm.description.trim() : undefined;
  return {
    name: name || undefined,
    description: description || undefined,
    allowedDomains: unique(allowed),
    rawFrontmatter: Object.keys(fm).length > 0,
    unexpectedFields: Object.keys(fm).filter((field) => !supportedFields.has(field)),
    invalidFields,
    metadataValid,
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
      isAllowedVersion(server.version) &&
      validOptionalString(server.title, 100) &&
      validOptionalUri(server.websiteUrl) &&
      validOptionalUri(server["$schema"]) &&
      validRepository(server.repository) &&
      validIcons(server.icons) &&
      validPackages(server.packages) &&
      validRemotes(server.remotes) &&
      (server._meta === undefined || isRecord(server._meta)),
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readUtf8IfSmall(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return undefined;
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

function isAllowedVersion(value: string): boolean {
  const version = value.trim();
  if (!version || version.length > 255 || version === "latest") return false;
  if (version.includes("||") || version.includes("&&")) return false;
  if (/^x$/i.test(version) || version.includes("*")) return false;
  if (/(?:^|[\s,])(?:\^|~=|~|>=|>|<=|<|!=|=)\s*\S/.test(version)) return false;
  if (/^(?:\[|\()\s*(?:v?\d|,).*?(?:\]|\))$/.test(version)) {
    return false;
  }
  const selectorVersion =
    "(?:v?\\d+|[xX*])(?:\\.(?:\\d+|[xX*]))*(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
  if (new RegExp(`^${selectorVersion}\\s+-\\s+${selectorVersion}$`).test(version)) {
    return false;
  }
  if (new RegExp(`^${selectorVersion}(?:\\s+${selectorVersion})+$`).test(version)) {
    return false;
  }
  const dottedSelector = new RegExp(
    "^((?:v?\\d+|[xX*])(?:\\.(?:\\d+|[xX*]))+)" +
      "(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
  );
  const dottedMatch = dottedSelector.exec(version);
  return !(
    dottedMatch &&
    /(?:^|\.)[xX*](?:\.|$)/.test((dottedMatch[1] ?? "").replace(/^v(?=\d)/i, ""))
  );
}

function validOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (
    typeof value === "string" && value.length >= 1 && value.length <= maxLength
  );
}

function validOptionalUri(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && isUri(value));
}

function isUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validRepository(value: unknown): boolean {
  if (value === undefined) return true;
  return Boolean(
    isRecord(value) &&
      typeof value.url === "string" &&
      isUri(value.url) &&
      typeof value.source === "string" &&
      value.source.trim() &&
      (value.id === undefined || typeof value.id === "string") &&
      (value.subfolder === undefined || typeof value.subfolder === "string"),
  );
}

function validIcons(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((icon) =>
    Boolean(
      isRecord(icon) &&
        typeof icon.src === "string" &&
        icon.src.length <= 255 &&
        /^https:\/\//i.test(icon.src) &&
        isUri(icon.src) &&
        (icon.mimeType === undefined ||
          ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"].includes(
            String(icon.mimeType),
          )) &&
        (icon.sizes === undefined ||
          (Array.isArray(icon.sizes) &&
            icon.sizes.every(
              (size) => typeof size === "string" && /^(?:\d+x\d+|any)$/.test(size),
            ))) &&
        (icon.theme === undefined || icon.theme === "light" || icon.theme === "dark"),
    ),
  );
}

function validPackages(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((pkg) =>
    Boolean(
      isRecord(pkg) &&
        typeof pkg.registryType === "string" &&
        pkg.registryType.trim() &&
        typeof pkg.identifier === "string" &&
        pkg.identifier.trim() &&
        validTransport(pkg.transport, true) &&
        (pkg.version === undefined ||
          (typeof pkg.version === "string" && isAllowedVersion(pkg.version))) &&
        validOptionalUri(pkg.registryBaseUrl) &&
        (pkg.fileSha256 === undefined ||
          (typeof pkg.fileSha256 === "string" && /^[a-f0-9]{64}$/.test(pkg.fileSha256))) &&
        (pkg.environmentVariables === undefined ||
          (Array.isArray(pkg.environmentVariables) &&
            pkg.environmentVariables.every(validKeyValueInput))) &&
        (pkg.packageArguments === undefined ||
          (Array.isArray(pkg.packageArguments) && pkg.packageArguments.every(validArgument))) &&
        (pkg.runtimeArguments === undefined ||
          (Array.isArray(pkg.runtimeArguments) && pkg.runtimeArguments.every(validArgument))) &&
        (pkg.runtimeHint === undefined || typeof pkg.runtimeHint === "string"),
    ),
  );
}

function validRemotes(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((remote) => validTransport(remote, false)));
}

function validTransport(value: unknown, local: boolean): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "stdio") return local;
  if (value.type !== "sse" && value.type !== "streamable-http") return false;
  return Boolean(
    typeof value.url === "string" &&
      /^(?:https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/.test(value.url) &&
      (value.headers === undefined ||
        (Array.isArray(value.headers) && value.headers.every(validKeyValueInput))) &&
      (value.variables === undefined ||
        (isRecord(value.variables) && Object.values(value.variables).every(validInput))),
  );
}

function validInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Boolean(
    (value.choices === undefined ||
      (Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === "string"))) &&
      (value.default === undefined || typeof value.default === "string") &&
      (value.description === undefined || typeof value.description === "string") &&
      (value.format === undefined ||
        ["string", "number", "boolean", "filepath"].includes(String(value.format))) &&
      (value.isRequired === undefined || typeof value.isRequired === "boolean") &&
      (value.isSecret === undefined || typeof value.isSecret === "boolean") &&
      (value.placeholder === undefined || typeof value.placeholder === "string") &&
      (value.value === undefined || typeof value.value === "string"),
  );
}

function validInputWithVariables(value: Record<string, unknown>): boolean {
  return Boolean(
    validInput(value) &&
      (value.variables === undefined ||
        (isRecord(value.variables) && Object.values(value.variables).every(validInput))),
  );
}

function validKeyValueInput(value: unknown): boolean {
  return Boolean(
    isRecord(value) &&
      validInputWithVariables(value) &&
      typeof value.name === "string",
  );
}

function validArgument(value: unknown): boolean {
  if (!isRecord(value) || !validInputWithVariables(value)) return false;
  if (value.isRepeated !== undefined && typeof value.isRepeated !== "boolean") return false;
  if (value.type === "named") return typeof value.name === "string";
  if (value.type !== "positional") return false;
  if (value.valueHint !== undefined && typeof value.valueHint !== "string") return false;
  return typeof value.valueHint === "string" || typeof value.value === "string";
}
