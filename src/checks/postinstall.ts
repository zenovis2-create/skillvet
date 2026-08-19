import type { CheckResult, Finding, ScanContext } from "../types.js";
import { clip } from "../walk.js";
import { finish } from "./manifest.js";

const HOOKS: { name: string; score: number }[] = [
  { name: "preinstall", score: 35 },
  { name: "install", score: 35 },
  { name: "postinstall", score: 35 },
  { name: "prepublish", score: 35 },
  { name: "prepare", score: 35 },
  { name: "prepublishOnly", score: 20 },
  { name: "prepack", score: 20 },
  { name: "postpack", score: 20 },
  { name: "dependencies", score: 20 },
  { name: "preuninstall", score: 20 },
  { name: "postuninstall", score: 20 },
];

export function checkPostinstall(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const scripts = ctx.pkg?.scripts ?? {};

  for (const hook of HOOKS) {
    const cmd = scripts[hook.name];
    if (!cmd) continue;
    findings.push({
      check: "postinstall",
      message: `package.json scripts.${hook.name} is an npm lifecycle hook`,
      file: "package.json",
      evidence: clip(cmd),
      score: hook.score,
    });
  }

  return finish("postinstall", "postinstall", findings, 45);
}
