import { SCORE_RED, SCORE_YELLOW, VERSION } from "./types.js";
import { redactUrls } from "./walk.js";

export interface CliArgs {
  target?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
  version: boolean;
  noColor: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    strict: false,
    help: false,
    version: false,
    noColor: false,
  };
  for (const raw of argv) {
    if (raw === "--json") args.json = true;
    else if (raw === "--strict") args.strict = true;
    else if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--version" || raw === "-v") args.version = true;
    else if (raw === "--no-color") args.noColor = true;
    else if (raw.startsWith("-")) {
      throw new Error(`unknown flag: ${redactUrls(raw)}`);
    } else if (!args.target) args.target = raw;
    else throw new Error(`unexpected argument: ${redactUrls(raw)}`);
  }
  return args;
}

export function helpText(): string {
  return `\
skillvet ${VERSION} — supply-chain scanner for AI agent skills & MCP servers

Usage:
  skillvet <path|url> [--json] [--strict]

Options:
  --json       machine-readable report
  --strict     any finding is YELLOW; score ≥ ${SCORE_YELLOW} is RED
  --no-color   disable ANSI colors
  -h, --help   show this help
  -v, --version

Exit codes:
  0  GREEN     score < ${SCORE_YELLOW}
  1  YELLOW    score ${SCORE_YELLOW}–${SCORE_RED - 1}
  2  RED       score ≥ ${SCORE_RED}
`;
}
