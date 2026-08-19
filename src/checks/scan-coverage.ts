import type { CheckResult, Finding, ScanContext } from "../types.js";
import { finish } from "./manifest.js";

export function checkScanCoverage(ctx: ScanContext): CheckResult {
  const findings: Finding[] = ctx.skippedFiles.map((file) => ({
    check: "scan-coverage",
    message: file.reason,
    file: file.relPath,
    score: 30,
  }));
  return finish("scan-coverage", "scan-coverage", findings, 30);
}
