import type { CheckResult, Finding, ScanContext } from "../types.js";
import { clip, eachLine } from "../walk.js";
import { finish } from "./manifest.js";

const PATTERNS: { re: RegExp; message: string; family: string }[] = [
  { family: "ssh", re: /(?:~|\$HOME|homedir\s*\(\s*\)|os\.homedir\s*\(\s*\))[^\n]{0,40}\.ssh\b/, message: "reads ~/.ssh" },
  { family: "ssh", re: /(?:['"`])\.ssh(?:['"`]|\/)/, message: "references .ssh path" },
  { family: "aws", re: /(?:~|\$HOME|homedir\s*\(\s*\)|os\.homedir\s*\(\s*\))[^\n]{0,40}\.aws\b/, message: "reads ~/.aws" },
  { family: "aws", re: /(?:['"`])\.aws(?:['"`]|\/)/, message: "references .aws path" },
  {
    family: "config",
    re: /(?:~|\$HOME|homedir\s*\(\s*\)|os\.homedir\s*\(\s*\))[^\n]{0,40}\.config\b/,
    message: "reads ~/.config",
  },
  { family: "token", re: /\bGITHUB_TOKEN\b/, message: "references GITHUB_TOKEN" },
  { family: "key", re: /\bAWS_SECRET_ACCESS_KEY\b/, message: "references AWS_SECRET_ACCESS_KEY" },
  { family: "key", re: /\bAWS_ACCESS_KEY_ID\b/, message: "references AWS_ACCESS_KEY_ID" },
  { family: "token", re: /process\.env\.[A-Z0-9_]*TOKEN\b/, message: "reads process.env *TOKEN" },
  { family: "key", re: /process\.env\.[A-Z0-9_]*KEY\b/, message: "reads process.env *KEY" },
  { family: "token", re: /process\.env\[[`'"][A-Z0-9_]*TOKEN[`'"]\]/, message: "reads process.env[*TOKEN]" },
  { family: "key", re: /process\.env\[[`'"][A-Z0-9_]*KEY[`'"]\]/, message: "reads process.env[*KEY]" },
  { family: "token", re: /os\.environ\[[`'"][A-Z0-9_]*TOKEN[`'"]\]/, message: "reads os.environ *TOKEN" },
  { family: "token", re: /os\.getenv\(\s*[`'"][A-Z0-9_]*(?:TOKEN|KEY)[`'"]/, message: "calls os.getenv for a secret" },
];

const SKIP = new Set(["readme.md", "changelog.md"]);

export function checkSecrets(ctx: ScanContext): CheckResult {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const file of ctx.textFiles) {
    if (SKIP.has(file.relPath.split("/").pop()?.toLowerCase() ?? "")) continue;
    eachLine(file.content, (line, lineNo) => {
      for (const pat of PATTERNS) {
        if (!pat.re.test(line)) continue;
        const key = `${pat.family}:${file.relPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          check: "secret-access",
          message: pat.message,
          file: file.relPath,
          line: lineNo,
          evidence: clip(line),
          score: 20,
        });
      }
    });
  }

  return finish("secret-access", "secret-access", findings, 45);
}
