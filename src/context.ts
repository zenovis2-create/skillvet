import type { ScanContext, ScanProfile, TargetKind } from "./types.js";
import {
  loadMcpManifest,
  loadPackageJson,
  loadSkillManifest,
} from "./manifest.js";
import { listFiles, readTextFiles } from "./walk.js";

export async function loadContext(
  root: string,
  profile: ScanProfile = "portable-agent-skill",
): Promise<ScanContext> {
  const skippedFiles: ScanContext["skippedFiles"] = [];
  const files = await listFiles(root, skippedFiles);
  const textFiles = await readTextFiles(files, skippedFiles);
  const pkg = await loadPackageJson(root);
  const skill = await loadSkillManifest(root, profile);
  const mcp = await loadMcpManifest(root, pkg);

  let kind: TargetKind = "unknown";
  if (skill) kind = "skill";
  else if (mcp) kind = "mcp";

  return { root, kind, skill, mcp, pkg, files, textFiles, skippedFiles };
}
