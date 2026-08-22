import { redactUrls } from "./walk.js";

export interface AuditCliArgs {
  target?: string;
  json: boolean;
  help: boolean;
  noColor: boolean;
  provider?: string;
  detectProviderVersion: boolean;
  failOn: string[];
  failOnUnreviewed: boolean;
  requireReviewed: boolean;
  assumeContext?: number;
}

export function parseAuditArgs(argv: string[]): AuditCliArgs {
  const args: AuditCliArgs = {
    json: false,
    help: false,
    noColor: false,
    detectProviderVersion: false,
    failOn: [],
    failOnUnreviewed: false,
    requireReviewed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (raw === "--json") args.json = true;
    else if (raw === "--no-color") args.noColor = true;
    else if (raw === "--detect-provider-version") args.detectProviderVersion = true;
    else if (raw === "--fail-on-unreviewed") args.failOnUnreviewed = true;
    else if (raw === "--require-reviewed") args.requireReviewed = true;
    else if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--provider") {
      args.provider = requiredValue(argv, ++index, "--provider");
    } else if (raw.startsWith("--provider=")) {
      args.provider = raw.slice("--provider=".length);
    } else if (raw === "--fail-on") {
      args.failOn.push(...selectors(requiredValue(argv, ++index, "--fail-on")));
    } else if (raw.startsWith("--fail-on=")) {
      args.failOn.push(...selectors(raw.slice("--fail-on=".length)));
    } else if (raw === "--assume-context") {
      args.assumeContext = positiveInteger(requiredValue(argv, ++index, "--assume-context"));
    } else if (raw.startsWith("--assume-context=")) {
      args.assumeContext = positiveInteger(raw.slice("--assume-context=".length));
    } else if (raw.startsWith("-")) {
      throw new Error(`unknown flag: ${redactUrls(raw)}`);
    } else if (!args.target) {
      args.target = raw;
    } else {
      throw new Error(`unexpected argument: ${redactUrls(raw)}`);
    }
  }
  return args;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function selectors(value: string): string[] {
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (parsed.length === 0) throw new Error("--fail-on requires at least one selector");
  return parsed;
}

function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error("--assume-context must be a positive integer");
  }
  return Number(value);
}

export function auditHelpText(version: string): string {
  return `\
skillvet ${version} — CI-grade audit for Claude Code workspaces

Usage:
  skillvet audit <workspace> [options]

Options:
  --provider claude-code@<version>  declare the runtime version
  --detect-provider-version         run \`claude --version\` only when requested
  --fail-on <dimension|id,...>      fail when eligible selected findings exist
  --fail-on-unreviewed              allow selected unreviewed findings to fail
  --require-reviewed                fail when version review coverage is unavailable
  --assume-context <tokens>         listing budget assumption (default: 200000)
  --json                            machine-readable report
  --no-color                        disable ANSI colors
  -h, --help                        show this help

Audit exit codes:
  0  no eligible failure (this is not necessarily GREEN)
  2  eligible selected finding failed
  3  requested provider-review gate was not evaluable
`;
}
