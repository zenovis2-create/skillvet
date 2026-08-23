import { resolveTarget } from "./resolve.js";
import { scan } from "./scan.js";
import { redactTarget } from "./safe-http.js";
import {
  VERSION,
  type CollectionEntry,
  type CollectionScanResult,
  type ScanOptions,
  type Verdict,
} from "./types.js";
import { redactUrls } from "./walk.js";
import { discoverDirectSkills } from "./skill-collection.js";

export async function scanCollection(
  target: string,
  options: ScanOptions = {},
): Promise<CollectionScanResult> {
  const resolved = await resolveTarget(target);
  try {
    const discovery = await discoverDirectSkills(resolved.path);
    if (discovery.skills.length === 0) {
      throw new Error("skill collection contains no direct directories with SKILL.md");
    }
    const entries: CollectionEntry[] = [];
    for (const skill of discovery.skills) {
      try {
        entries.push({
          name: skill.name,
          path: redactUrls(skill.path),
          link: skill.link,
          result: await scan(skill.path, options),
        });
      } catch (error) {
        entries.push({
          name: skill.name,
          path: redactUrls(skill.path),
          link: skill.link,
          error: redactUrls(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    const summary = summarize(entries);
    return {
      version: VERSION,
      target: redactUrls(redactTarget(target)),
      resolvedPath: redactUrls(resolved.path),
      kind: "skill-collection",
      strict: Boolean(options.strict),
      profile: options.profile ?? "portable-agent-skill",
      verdict: verdictForSummary(summary),
      summary,
      entries,
      skipped: discovery.skipped,
    };
  } finally {
    if (resolved.cleanup) await resolved.cleanup();
  }
}

function summarize(entries: CollectionEntry[]): CollectionScanResult["summary"] {
  const summary = { discovered: entries.length, scanned: 0, errors: 0, green: 0, yellow: 0, red: 0 };
  for (const entry of entries) {
    if (entry.error) {
      summary.errors += 1;
      continue;
    }
    summary.scanned += 1;
    if (entry.result?.verdict === "GREEN") summary.green += 1;
    else if (entry.result?.verdict === "YELLOW") summary.yellow += 1;
    else if (entry.result?.verdict === "RED") summary.red += 1;
  }
  return summary;
}

function verdictForSummary(summary: CollectionScanResult["summary"]): Verdict {
  if (summary.errors > 0 || summary.red > 0) return "RED";
  if (summary.yellow > 0) return "YELLOW";
  return "GREEN";
}
