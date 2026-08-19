import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext } from "../src/context.js";
import type { ScanContext } from "../src/types.js";

export const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function fixture(name: string): string {
  return path.join(fixtures, name);
}

export async function withTempSkill(
  files: Record<string, string | Buffer>,
  directoryName?: string,
): Promise<{ root: string; ctx: ScanContext; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), "skillvet-test-"));
  const skillMd = files["SKILL.md"];
  const declaredName =
    typeof skillMd === "string"
      ? skillMd.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim()
      : undefined;
  const root = path.join(base, directoryName ?? declaredName ?? "fixture");
  await mkdir(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }
  const ctx = await loadContext(root);
  return {
    root,
    ctx,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export function skillMd(fields: {
  name?: string;
  description?: string;
  allowed?: string[];
}): string {
  const lines = ["---"];
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`);
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.allowed && fields.allowed.length > 0) {
    lines.push("allowed-domains:");
    for (const d of fields.allowed) lines.push(`  - ${d}`);
  }
  lines.push("---", "", "# fixture", "");
  return lines.join("\n");
}
