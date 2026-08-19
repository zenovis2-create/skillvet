import type { CheckResult, Finding, ScanContext } from "../types.js";
import { clip } from "../walk.js";
import { finish } from "./manifest.js";

const HOOKS: { name: string; score: number }[] = [
  { name: "preinstall", score: 35 },
  { name: "install", score: 35 },
  { name: "postinstall", score: 35 },
  { name: "prepublish", score: 35 },
  { name: "preprepare", score: 35 },
  { name: "prepare", score: 35 },
  { name: "postprepare", score: 35 },
  { name: "prepublishOnly", score: 20 },
  { name: "prepack", score: 20 },
  { name: "postpack", score: 20 },
  { name: "dependencies", score: 20 },
  { name: "preuninstall", score: 20 },
  { name: "postuninstall", score: 20 },
];

export function checkPostinstall(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const scripts = ctx.pkg?.scripts;

  if (
    scripts !== undefined &&
    (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
  ) {
    findings.push({
      check: "postinstall",
      message: "package.json scripts must be an object of command strings",
      file: "package.json",
      score: 35,
    });
  }

  for (const hook of HOOKS) {
    const cmd = scriptValue(scripts, hook.name);
    if (cmd === undefined || cmd === "") continue;
    if (typeof cmd !== "string") {
      findings.push({
        check: "postinstall",
        message: `package.json scripts.${hook.name} must be a command string`,
        file: "package.json",
        score: hook.score,
      });
      continue;
    }
    findings.push({
      check: "postinstall",
      message: `package.json scripts.${hook.name} is an npm lifecycle hook`,
      file: "package.json",
      evidence: clip(cmd),
      score: hook.score,
    });
  }

  const hasBindingGyp = ctx.files.some((file) => file.relPath === "binding.gyp");
  if (
    hasBindingGyp &&
    ctx.pkg?.gypfile !== false &&
    !scriptValue(scripts, "install") &&
    !scriptValue(scripts, "preinstall")
  ) {
    findings.push({
      check: "postinstall",
      message: "binding.gyp triggers npm's implicit node-gyp rebuild install",
      file: "binding.gyp",
      score: 35,
    });
  }

  return finish("postinstall", "postinstall", findings, 45);
}

function scriptValue(scripts: unknown, name: string): unknown {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return undefined;
  }
  return Reflect.get(scripts, name);
}
