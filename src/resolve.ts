import { mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSafeTar, extractSafeZip, selectExtractedRoot } from "./archive.js";
import { parseGitHubTarget, resolveGitHubTreeReference } from "./github.js";
import { safeGet } from "./safe-http.js";

export interface ResolvedTarget {
  path: string;
  cleanup?: () => Promise<void>;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export async function resolveTarget(target: string): Promise<ResolvedTarget> {
  const remoteTarget = target
    .replace(/[\u0009\u000a\u000d]/g, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (/^https?:/i.test(remoteTarget)) {
    if (!/^https?:\/\//i.test(remoteTarget)) throw new Error("invalid remote URL");
    return fetchRemote(remoteTarget);
  }
  const resolved = path.resolve(target);
  try {
    await stat(resolved);
  } catch {
    throw new Error(`path not found: ${target}`);
  }
  return { path: resolved };
}

async function fetchRemote(url: string): Promise<ResolvedTarget> {
  const dest = await mkdtemp(path.join(tmpdir(), "skillvet-"));
  const cleanup = async () => {
    await rm(dest, { recursive: true, force: true });
  };

  try {
    const gh = parseGitHubTarget(url);
    if (gh) {
      let ref = "HEAD";
      let subdir = "";
      if (gh.treeParts) {
        const resolvedRef = await resolveGitHubTreeReference(
          gh.owner,
          gh.repo,
          gh.treeParts,
        );
        ref = resolvedRef.sha;
        subdir = resolvedRef.subdir;
      }
      const tarball = `https://codeload.github.com/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/tar.gz/${encodeURIComponent(ref)}`;
      const tarPath = path.join(dest, "src.tar.gz");
      await downloadToFile(tarball, tarPath);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await extractSafeTar(tarPath, unpack);
      const extractedRoot = await selectExtractedRoot(unpack);
      let root = extractedRoot;
      if (path.dirname(extractedRoot) === unpack) {
        root = path.join(unpack, gh.repo);
        await rename(extractedRoot, root);
      }
      return {
        path: subdir ? await resolveContainedPath(root, subdir) : root,
        cleanup,
      };
    }

    const res = await safeGet(url, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`download failed with HTTP ${res.status}`);
    }
    const buf = res.body;
    const name = guessName(url);
    if (isGzip(buf) || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      const tarPath = path.join(dest, "src.tar.gz");
      await writeFile(tarPath, buf);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await extractSafeTar(tarPath, unpack);
      return { path: await selectExtractedRoot(unpack), cleanup };
    }
    if (isZip(buf) || name.endsWith(".zip")) {
      const zipPath = path.join(dest, "src.zip");
      await writeFile(zipPath, buf);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await extractSafeZip(zipPath, unpack);
      return { path: unpack, cleanup };
    }
    await writeFile(path.join(dest, name || "SKILL.md"), buf);
    return { path: dest, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function resolveContainedPath(
  root: string,
  subdir: string,
): Promise<string> {
  const rootPath = await realpath(root);
  const candidate = path.resolve(rootPath, subdir);
  if (!isWithin(rootPath, candidate)) {
    throw new Error(`refusing remote subdirectory outside target: ${subdir}`);
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`remote subdirectory not found: ${subdir}`);
  }
  if (!isWithin(rootPath, resolved)) {
    throw new Error(`refusing remote subdirectory outside target: ${subdir}`);
  }
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await safeGet(url, {
    maxBytes: MAX_DOWNLOAD_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`download failed with HTTP ${res.status}`);
  }
  await writeFile(dest, res.body);
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function guessName(url: string): string {
  try {
    const u = new URL(url);
    const base = path.posix.basename(u.pathname);
    return base || "download";
  } catch {
    return "download";
  }
}
