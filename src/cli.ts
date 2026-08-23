#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseAuditArgs, auditHelpText, type AuditCliArgs } from "./audit-args.js";
import { audit, auditExitCode } from "./audit.js";
import { formatAuditReport } from "./audit-report.js";
import { parseCodexAuditArgs, codexAuditHelpText, type CodexAuditCliArgs } from "./codex-audit-args.js";
import { auditCodex, codexAuditExitCode } from "./codex-audit.js";
import { formatCodexAuditReport } from "./codex-audit-report.js";
import { helpText, parseArgs, type CliArgs } from "./args.js";
import { formatCollectionReport, formatReport, shouldColor } from "./report.js";
import { scan } from "./scan.js";
import { scanCollection } from "./collection.js";
import { SkillCollectionTargetError } from "./skill-collection.js";
import { exitCodeFor } from "./score.js";
import { VERSION } from "./types.js";
import { redactUrls } from "./walk.js";

export { parseArgs, helpText } from "./args.js";
export type { CliArgs } from "./args.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "audit" && rest[0] === "codex") return runCodexAudit(rest.slice(1));
  if (command === "audit") return runAudit(rest);
  if (command === "scan") return runScan(rest);
  return runScan(argv);
}

async function runCodexAudit(argv: string[]): Promise<number> {
  let args: CodexAuditCliArgs;
  try {
    args = parseCodexAuditArgs(argv);
  } catch (err) {
    process.stderr.write(`${redactUrls(err instanceof Error ? err.message : String(err))}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(codexAuditHelpText(VERSION));
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.target) {
    process.stderr.write(codexAuditHelpText(VERSION));
    return 2;
  }
  try {
    const result = await auditCodex(args.target, { profile: args.profile });
    const report = formatCodexAuditReport(result, {
      json: args.json,
      color: shouldColor({ json: args.json, noColor: args.noColor }),
    });
    process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
    return codexAuditExitCode(result);
  } catch (err) {
    const message = redactUrls(err instanceof Error ? err.message : String(err));
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ error: message, status: "FAIL", exitCode: 2 }, null, 2)}\n`);
    } else {
      process.stderr.write(`skillvet audit codex: ${message}\n`);
    }
    return 2;
  }
}

async function runScan(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${redactUrls(err instanceof Error ? err.message : String(err))}\n`);
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
    if (args.collection) {
      const result = await scanCollection(args.target, { strict: args.strict, profile: args.profile });
      const report = formatCollectionReport(result, {
        json: args.json,
        color: shouldColor({ json: args.json, noColor: args.noColor }),
      });
      process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
      return exitCodeFor(result.verdict);
    }
    const result = await scan(args.target, { strict: args.strict, profile: args.profile });
    const report = formatReport(result, {
      json: args.json,
      color: shouldColor({ json: args.json, noColor: args.noColor }),
    });
    process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
    return exitCodeFor(result.verdict);
  } catch (err) {
    const message = redactUrls(err instanceof Error ? err.message : String(err));
    if (err instanceof SkillCollectionTargetError) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({
          error: message,
          kind: "skill-collection",
          skillCount: err.skillCount,
          hint: "rerun with --collection for one result per direct skill",
          exitCode: 2,
        }, null, 2)}\n`);
      } else {
        process.stderr.write(`skillvet: ${message}\n`);
      }
      return 2;
    }
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

async function runAudit(argv: string[]): Promise<number> {
  let args: AuditCliArgs;
  try {
    args = parseAuditArgs(argv);
  } catch (err) {
    process.stderr.write(`${redactUrls(err instanceof Error ? err.message : String(err))}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(auditHelpText(VERSION));
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.target) {
    process.stderr.write(auditHelpText(VERSION));
    return 2;
  }
  try {
    const options = {
      provider: args.provider,
      detectProviderVersion: args.detectProviderVersion,
      failOn: args.failOn,
      failOnUnreviewed: args.failOnUnreviewed,
      requireReviewed: args.requireReviewed,
      assumeContext: args.assumeContext,
      codexProjectDocMaxBytes: args.codexProjectDocMaxBytes,
    };
    const result = await audit(args.target, options);
    const report = formatAuditReport(result, {
      json: args.json,
      color: shouldColor({ json: args.json, noColor: args.noColor }),
      auditOptions: options,
    });
    process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
    return auditExitCode(result, options);
  } catch (err) {
    const message = redactUrls(err instanceof Error ? err.message : String(err));
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ error: message, status: "FAIL", exitCode: 2 }, null, 2)}\n`);
    } else {
      process.stderr.write(`skillvet audit: ${message}\n`);
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
