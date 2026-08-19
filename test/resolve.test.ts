import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  extractSafeTar,
  selectExtractedRoot,
  validateArchiveListing,
  validateArchiveMembers,
} from "../src/archive.js";
import { selectGitHubRef } from "../src/github.js";
import { resolveContainedPath, resolveTarget } from "../src/resolve.js";
import { collectLimitedBody, isBlockedAddress, redactTarget } from "../src/safe-http.js";

const execFileAsync = promisify(execFile);

describe("remote subdirectory resolution", () => {
  it("rejects lexical and symlink escapes from the extracted root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "skillvet-resolve-test-"));
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "link"));
    try {
      await expect(resolveContainedPath(root, "../../outside")).rejects.toThrow(/outside/i);
      await expect(resolveContainedPath(root, "link")).rejects.toThrow(/outside/i);
      await expect(resolveContainedPath(root, ".")).resolves.toBe(await realpath(root));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("remote archive limits", () => {
  it("rejects bodies larger than the configured byte limit", async () => {
    async function* oversizedBody() {
      yield Buffer.from("1234");
      yield Buffer.from("56789");
    }
    await expect(collectLimitedBody(oversizedBody(), undefined, 8)).rejects.toThrow(/8 bytes/i);
    await expect(collectLimitedBody([], "9", 8)).rejects.toThrow(/8 bytes/i);
  });

  it("rejects archive escapes without rejecting harmless double dots", () => {
    expect(() => validateArchiveMembers(["root/foo..bar.txt"])).not.toThrow();
    expect(() => validateArchiveMembers(["root/../escape.txt"])).toThrow(/outside/i);
    expect(() => validateArchiveMembers(["root\\..\\escape.txt"])).toThrow(/outside/i);
    expect(() => validateArchiveMembers(["/absolute.txt"])).toThrow(/outside/i);
    expect(() => validateArchiveMembers(["C:../escape.txt"])).toThrow(/outside/i);
  });

  it("keeps the extraction root when top-level files accompany one directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skillvet-mixed-root-"));
    try {
      await mkdir(path.join(root, "skill"));
      await writeFile(path.join(root, "payload.js"), "process.env.GITHUB_TOKEN\n");
      await expect(selectExtractedRoot(root)).resolves.toBe(root);
      await rm(path.join(root, "payload.js"));
      await expect(selectExtractedRoot(root)).resolves.toBe(path.join(root, "skill"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scans mixed-root tar payloads from the complete extraction root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "skillvet-mixed-tar-"));
    const source = path.join(base, "source");
    const archive = path.join(base, "mixed.tar.gz");
    await mkdir(path.join(source, "skill"), { recursive: true });
    await writeFile(path.join(source, "skill", "SKILL.md"), "---\nname: skill\ndescription: demo\n---\n");
    await writeFile(path.join(source, "payload.js"), "process.env.GITHUB_TOKEN\n");
    await execFileAsync("tar", ["-czf", archive, "-C", source, "skill", "payload.js"]);
    const unpack = path.join(base, "unpack");
    try {
      await mkdir(unpack);
      await extractSafeTar(archive, unpack);
      const root = await selectExtractedRoot(unpack);
      await expect(readFile(path.join(root, "payload.js"), "utf8")).resolves.toMatch(
        /GITHUB_TOKEN/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects loopback URLs before opening a connection", async () => {
    await expect(resolveTarget("http://127.0.0.1:65535/payload.tgz")).rejects.toThrow(
      /private|blocked|non-public/i,
    );
  });

  it("redacts URL credentials, queries, and fragments", () => {
    expect(redactTarget("https://user:pass@example.com/a?token=secret#part")).toBe(
      "https://example.com/a",
    );
  });

  it("classifies private, link-local, loopback, and mapped addresses as blocked", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("selects the longest matching GitHub ref before the subdirectory", () => {
    expect(
      selectGitHubRef(
        ["release", "2.0", "skill"],
        ["refs/heads/release", "refs/heads/release/2.0"],
      ),
    ).toEqual({ ref: "release/2.0", subdir: "skill" });
  });

  it("rejects archive links and special device entries", () => {
    expect(() => validateArchiveListing("-rw-r--r-- file.txt", "tar")).not.toThrow();
    expect(() => validateArchiveListing("lrwxr-xr-x link -> /tmp", "tar")).toThrow(/link/i);
    expect(() => validateArchiveListing("prw-r--r-- pipe", "tar")).toThrow(/special/i);
  });
});
