import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readLimitedResponse,
  resolveContainedPath,
  validateArchiveListing,
  validateArchiveMembers,
} from "../src/resolve.js";

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
  });

  it("rejects archive links and special device entries", () => {
    expect(() => validateArchiveListing("-rw-r--r-- file.txt", "tar")).not.toThrow();
    expect(() => validateArchiveListing("lrwxr-xr-x link -> /tmp", "tar")).toThrow(/link/i);
    expect(() => validateArchiveListing("prw-r--r-- pipe", "tar")).toThrow(/special/i);
  });
});
