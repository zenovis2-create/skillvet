import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  selectExtractedRoot,
  validateArchiveListing,
  validateArchiveMembers,
} from "../src/archive.js";
import { selectGitHubRef } from "../src/github.js";
import {
  readLimitedResponse,
  resolveContainedPath,
  resolveTarget,
} from "../src/resolve.js";

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
    const response = new Response(Buffer.from("123456789"));
    await expect(readLimitedResponse(response, 8)).rejects.toThrow(/8 bytes/i);

    const declared = new Response("", { headers: { "content-length": "9" } });
    await expect(readLimitedResponse(declared, 8)).rejects.toThrow(/8 bytes/i);
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
    const body = await readFile(archive);
    const server = createServer((_request, response) => response.end(body));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    let resolved;
    try {
      resolved = await resolveTarget(`http://127.0.0.1:${address.port}/mixed.tar.gz`);
      await expect(readFile(path.join(resolved.path, "payload.js"), "utf8")).resolves.toMatch(
        /GITHUB_TOKEN/,
      );
    } finally {
      await resolved?.cleanup?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(base, { recursive: true, force: true });
    }
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
