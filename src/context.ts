import type { ScanContext, TargetKind } from "./types.js";
import {
  allowedDomainsFromPackage,
  loadMcpManifest,
  loadPackageJson,
  loadSkillManifest,
} from "./manifest.js";
import { listFiles, readTextFiles } from "./walk.js";

export async function loadContext(root: string): Promise<ScanContext> {
  const files = await listFiles(root);
  const textFiles = await readTextFiles(files);
  const pkg = await loadPackageJson(root);
  const skill = await loadSkillManifest(root);
  const mcp = await loadMcpManifest(root, pkg);

  if (skill && pkg) {
    skill.allowedDomains = unique([
      ...skill.allowedDomains,
      ...allowedDomainsFromPackage(pkg),
    ]);
  }

  let kind: TargetKind = "unknown";
  if (skill) kind = "skill";
  else if (mcp) kind = "mcp";

  return { root, kind, skill, mcp, pkg, files, textFiles };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
