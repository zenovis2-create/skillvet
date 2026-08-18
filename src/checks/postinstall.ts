import type { CheckResult, Finding, ScanContext } from "../types.js";
import { clip } from "../walk.js";
import { finish } from "./manifest.js";

const HOOKS = ["preinstall", "install", "postinstall", "preuninstall", "postuninstall"];

export function checkPostinstall(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const scripts = ctx.pkg?.scripts ?? {};

  for (const hook of HOOKS) {
    const cmd = scripts[hook];
    if (!cmd) continue;
    const autoYellow = hook === "preinstall" || hook === "postinstall" || hook === "install";
    findings.push({
      check: "postinstall",
      message: `package.json scripts.${hook} runs automatically on install`,
      file: "package.json",
      evidence: clip(cmd),
      score: autoYellow ? 35 : 20,
    });
  }

  return finish("postinstall", "postinstall", findings, 45);
}
