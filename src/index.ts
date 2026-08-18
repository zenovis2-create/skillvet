export { scan } from "./scan.js";
export { formatReport, toJson } from "./report.js";
export { exitCodeFor, verdictFor, scoreFindings } from "./score.js";
export { parseArgs, helpText } from "./args.js";
export { VERSION, SCORE_RED, SCORE_YELLOW } from "./types.js";
export type {
  ScanResult,
  ScanOptions,
  Finding,
  CheckResult,
  Verdict,
  TargetKind,
} from "./types.js";
