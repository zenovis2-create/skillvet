import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectRun } from "../src/cli.js";

describe("CLI entrypoint", () => {
  it("recognizes an npm-style symlink as a direct invocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skillvet-cli-test-"));
    const entry = path.join(root, "skillvet");
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    await symlink(cli, entry);
    try {
      expect(isDirectRun(entry)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts URL-shaped credentials embedded in path errors", () => {
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const target = path.join(
      tmpdir(),
      "https:path-user:path-pass@example.com?path=secret#part",
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", target, "--json"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("path not found");
    expect(result.stdout).toContain("example.com");
    expect(result.stdout).not.toMatch(/path-user|path-pass|path=secret|#part/);
  });
});
