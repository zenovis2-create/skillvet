#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { helpText, parseArgs, type CliArgs } from "./args.js";
import { formatReport, shouldColor } from "./report.js";
import { scan } from "./scan.js";
import { exitCodeFor } from "./score.js";
import { VERSION } from "./types.js";

export { parseArgs, helpText } from "./args.js";
export type { CliArgs } from "./args.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.target) {
    process.stderr.write(helpText());
    return 2;
  }
  try {
    const result = await scan(args.target, { strict: args.strict });
    const report = formatReport(result, {
      json: args.json,
      color: shouldColor({ json: args.json, noColor: args.noColor }),
    });
    process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
    return exitCodeFor(result.verdict);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ error: message, verdict: "RED", score: 100 }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`skillvet: ${message}\n`);
    }
    return 2;
  }
}

export function isDirectRun(entry = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
