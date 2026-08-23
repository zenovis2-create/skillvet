import { redactUrls } from "./walk.js";

export interface CodexAuditCliArgs {
  target?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  noColor: boolean;
  profile?: string;
}

export function parseCodexAuditArgs(argv: string[]): CodexAuditCliArgs {
  const args: CodexAuditCliArgs = {
    json: false,
    help: false,
    version: false,
    noColor: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (raw === "--json") args.json = true;
    else if (raw === "--no-color") args.noColor = true;
    else if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--version" || raw === "-v") args.version = true;
    else if (raw === "--profile") args.profile = requiredValue(argv, ++index, "--profile");
    else if (raw.startsWith("--profile=")) args.profile = raw.slice("--profile=".length);
    else if (raw.startsWith("-")) throw new Error(`unknown flag: ${redactUrls(raw)}`);
    else if (!args.target) args.target = raw;
    else throw new Error(`unexpected argument: ${redactUrls(raw)}`);
  }
  return args;
}

export function codexAuditHelpText(version: string): string {
  return `\
skillvet ${version} -- static audit for a Codex home directory

Usage:
  skillvet audit codex <CODEX_HOME> [options]

This mode reads config.toml, global AGENTS instruction files, and direct skills. It does not execute Codex,
start MCP servers, download packages, or treat a skill collection as one skill.

Options:
  --profile    layer <name>.config.toml over config.toml before auditing
  --json       machine-readable report
  --no-color   disable ANSI colors
  -h, --help   show this help
  -v, --version
`;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}
