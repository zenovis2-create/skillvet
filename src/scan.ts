import { checkBinariesAsync } from "./checks/binaries.js";
import { checkManifest } from "./checks/manifest.js";
import { checkObfuscation } from "./checks/obfuscation.js";
import { checkPhoneHome } from "./checks/phone-home.js";
import { checkPostinstall } from "./checks/postinstall.js";
import { checkSecrets } from "./checks/secrets.js";
import { loadContext } from "./context.js";
import { resolveTarget } from "./resolve.js";
import { scoreFindings } from "./score.js";
import {
  SCORE_RED,
  SCORE_YELLOW,
  VERSION,
  type CheckResult,
  type ScanOptions,
  type ScanResult,
} from "./types.js";

export async function scan(target: string, options: ScanOptions = {}): Promise<ScanResult> {
  const resolved = await resolveTarget(target);
  try {
    const ctx = await loadContext(resolved.path);
    const checks: CheckResult[] = [
      checkPhoneHome(ctx),
      checkSecrets(ctx),
      checkPostinstall(ctx),
      checkObfuscation(ctx),
      await checkBinariesAsync(ctx),
      checkManifest(ctx),
    ];
    const findings = checks.flatMap((c) => c.findings);
    const { score, verdict } = scoreFindings(findings, options);
    return {
      version: VERSION,
      target,
      resolvedPath: resolved.path,
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
