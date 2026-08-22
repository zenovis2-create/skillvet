import { SCORE_RED, SCORE_YELLOW, VERSION, type ScanProfile } from "./types.js";
import { redactUrls } from "./walk.js";

export interface CliArgs {
  target?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
  version: boolean;
  noColor: boolean;
  profile?: ScanProfile;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    strict: false,
    help: false,
    version: false,
    noColor: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (raw === "--json") args.json = true;
    else if (raw === "--strict") args.strict = true;
    else if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--version" || raw === "-v") args.version = true;
    else if (raw === "--no-color") args.noColor = true;
    else if (raw === "--profile") {
      args.profile = parseProfile(argv[++index]);
    } else if (raw.startsWith("--profile=")) {
      args.profile = parseProfile(raw.slice("--profile=".length));
    }
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
  skillvet <path|url> [--json] [--strict] [--profile <name>]

Options:
  --json       machine-readable report
  --strict     any finding is YELLOW; score ≥ ${SCORE_YELLOW} is RED
  --profile    portable-agent-skill (default) or claude-code
  --no-color   disable ANSI colors
  -h, --help   show this help
  -v, --version

Exit codes:
  0  GREEN     score < ${SCORE_YELLOW}
  1  YELLOW    score ${SCORE_YELLOW}–${SCORE_RED - 1}
  2  RED       score ≥ ${SCORE_RED}
`;
}

function parseProfile(value: string | undefined): ScanProfile {
  if (value === "portable-agent-skill" || value === "claude-code") return value;
  throw new Error("--profile must be portable-agent-skill or claude-code");
}
