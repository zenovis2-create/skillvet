import { checkBinariesAsync } from "./checks/binaries.js";
import { stat } from "node:fs/promises";
import { checkManifest } from "./checks/manifest.js";
import { checkObfuscation } from "./checks/obfuscation.js";
import { checkPhoneHome } from "./checks/phone-home.js";
import { checkPostinstall } from "./checks/postinstall.js";
import { checkScanCoverage } from "./checks/scan-coverage.js";
import { checkSecrets } from "./checks/secrets.js";
import { loadContext } from "./context.js";
import { resolveTarget } from "./resolve.js";
import { redactTarget } from "./safe-http.js";
import { scoreFindings } from "./score.js";
import {
  discoverDirectSkills,
  hasOwnSkillManifest,
  SkillCollectionTargetError,
} from "./skill-collection.js";
import { redactFinding, redactUrls } from "./walk.js";
import {
  SCORE_RED,
  SCORE_YELLOW,
  VERSION,
  type CheckResult,
  type ScanOptions,
  type ScanResult,
} from "./types.js";

export async function scan(target: string, options: ScanOptions = {}): Promise<ScanResult> {
  try {
    return await scanTarget(target, options);
  } catch (error) {
    if (error instanceof SkillCollectionTargetError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactUrls(message));
  }
}

async function scanTarget(target: string, options: ScanOptions): Promise<ScanResult> {
  const resolved = await resolveTarget(target);
  try {
    const info = await stat(resolved.path);
    if (info.isDirectory() && !await hasOwnSkillManifest(resolved.path)) {
      const discovery = await discoverDirectSkills(resolved.path);
      if (discovery.skills.length > 1) {
        throw new SkillCollectionTargetError(discovery.skills.length);
      }
    }
    const ctx = await loadContext(resolved.path, options.profile);
    const checks: CheckResult[] = [
      checkPhoneHome(ctx),
      checkSecrets(ctx),
      checkPostinstall(ctx),
      checkObfuscation(ctx),
      await checkBinariesAsync(ctx),
      checkScanCoverage(ctx),
      checkManifest(ctx),
    ].map((check) => ({ ...check, findings: check.findings.map(redactFinding) }));
    const findings = checks.flatMap((c) => c.findings);
    const { score, verdict } = scoreFindings(findings, options);
    return {
      version: VERSION,
      target: redactUrls(redactTarget(target)),
      resolvedPath: redactUrls(resolved.path),
      kind: ctx.kind,
      verdict,
      score,
      strict: Boolean(options.strict),
      thresholds: { yellow: SCORE_YELLOW, red: SCORE_RED },
      checks,
      findings,
    };
  } finally {
    if (resolved.cleanup) await resolved.cleanup();
  }
}
