import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { redactUrls, toPosix } from "./walk.js";

export interface DirectSkillDirectory {
  name: string;
  path: string;
  link: boolean;
}

export interface DirectSkillDiscovery {
  skills: DirectSkillDirectory[];
  skipped: Array<{ relPath: string; reason: string }>;
}

export class SkillCollectionTargetError extends Error {
  readonly skillCount: number;

  constructor(skillCount: number) {
    super(
      `target contains ${skillCount} direct skills; run scan with --collection to receive one result per skill`,
    );
    this.name = "SkillCollectionTargetError";
    this.skillCount = skillCount;
  }
}

export async function discoverDirectSkills(root: string): Promise<DirectSkillDiscovery> {
  const skills: DirectSkillDirectory[] = [];
  const skipped: DirectSkillDiscovery["skipped"] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error(`skill collection directory could not be read: ${redactUrls(root)}`);
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(root, entry.name);
    let link = entry.isSymbolicLink();
    let info;
    try {
      const beforeFollow = await lstat(candidate);
      link ||= beforeFollow.isSymbolicLink();
      info = await stat(candidate);
    } catch {
      skipped.push({
        relPath: toPosix(entry.name),
        reason: "direct entry could not be inspected",
      });
      continue;
    }
    if (!info.isDirectory()) continue;

    try {
      const manifest = await stat(path.join(candidate, "SKILL.md"));
      if (!manifest.isFile()) continue;
    } catch {
      continue;
    }
    skills.push({ name: entry.name, path: candidate, link });
  }
  return { skills, skipped };
}

export async function hasOwnSkillManifest(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}
