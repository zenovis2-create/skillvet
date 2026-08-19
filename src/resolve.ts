import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ResolvedTarget {
  path: string;
  cleanup?: () => Promise<void>;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const MAX_LISTING_BYTES = 5 * 1024 * 1024;

const GITHUB =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?(?:\/)?(?:\.git)?$/i;

export async function resolveTarget(target: string): Promise<ResolvedTarget> {
  if (/^https?:\/\//i.test(target)) {
    return fetchRemote(target);
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
    const gh = url.match(GITHUB);
    if (gh) {
      const owner = gh[1] ?? "";
      const repo = (gh[2] ?? "").replace(/\.git$/i, "");
      const ref = gh[3] || "HEAD";
      const subdir = (gh[4] ?? "").replace(/\/$/, "");
      const tarball = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
      const tarPath = path.join(dest, "src.tar.gz");
      await downloadToFile(tarball, tarPath);
      await assertSafeTar(tarPath);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await run("tar", ["-xzf", tarPath, "-C", unpack]);
      const root = await firstChildDir(unpack);
      return {
        path: subdir ? await resolveContainedPath(root, subdir) : root,
        cleanup,
      };
    }

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const buf = await readLimitedResponse(res, MAX_DOWNLOAD_BYTES);
    const name = guessName(url);
    if (isGzip(buf) || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      const tarPath = path.join(dest, "src.tar.gz");
      await writeFile(tarPath, buf);
      await assertSafeTar(tarPath);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await run("tar", ["-xzf", tarPath, "-C", unpack]);
      return { path: await firstChildDir(unpack), cleanup };
    }
    if (isZip(buf) || name.endsWith(".zip")) {
      const zipPath = path.join(dest, "src.zip");
      await writeFile(zipPath, buf);
      const unpack = path.join(dest, "unpack");
      await mkdirp(unpack);
      await assertSafeZip(zipPath);
      await run("unzip", ["-q", zipPath, "-d", unpack]);
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
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`download failed (${url}): ${res.status} ${res.statusText}`);
  }
  await writeFile(dest, await readLimitedResponse(res, MAX_DOWNLOAD_BYTES));
}

async function assertSafeTar(tarPath: string): Promise<void> {
  const listing = await run("tar", ["-tzf", tarPath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveMembers(listing.split("\n").filter(Boolean));
  const verbose = await run("tar", ["-tvzf", tarPath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveListing(verbose, "tar");
  await run("tar", ["-xOzf", tarPath], {
    captureOutput: false,
    maxOutputBytes: MAX_EXPANDED_BYTES,
  });
}

async function assertSafeZip(zipPath: string): Promise<void> {
  const listing = await run("unzip", ["-Z1", zipPath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveMembers(listing.split("\n").filter(Boolean));
  const verbose = await run("unzip", ["-Z", "-l", zipPath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveListing(verbose, "zip");
  await run("unzip", ["-p", zipPath], {
    captureOutput: false,
    maxOutputBytes: MAX_EXPANDED_BYTES,
  });
}

export function validateArchiveMembers(members: string[]): void {
  if (members.length > MAX_ARCHIVE_FILES) {
    throw new Error(`refusing archive with more than ${MAX_ARCHIVE_FILES} entries`);
  }
  for (const member of members) {
    const normalized = member.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.includes("\0") ||
      parts.includes("..")
    ) {
      throw new Error(`refusing archive member outside target: ${member}`);
    }
  }
}

export function validateArchiveListing(
  verboseListing: string,
  kind: string,
): void {
  for (const line of verboseListing.split("\n")) {
    const type = line.trimStart()[0];
    if (type === "l" || type === "h") {
      throw new Error(`refusing ${kind} archive link: ${line.trim()}`);
    }
    if (type && "bcps".includes(type)) {
      throw new Error(`refusing ${kind} archive special entry: ${line.trim()}`);
    }
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  }
}

export async function readLimitedResponse(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`download exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`download exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function firstChildDir(dir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && dirs[0]) return path.join(dir, dirs[0].name);
  return dir;
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

interface RunOptions {
  captureOutput?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

function run(cmd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const captureOutput = options.captureOutput ?? true;
    const maxOutputBytes = options.maxOutputBytes ?? MAX_LISTING_BYTES;
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    let out = "";
    let err = "";
    let outBytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`${cmd} timed out after ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > maxOutputBytes && !failure) {
        failure = new Error(`${cmd} output exceeds ${maxOutputBytes} bytes`);
        child.kill("SIGKILL");
        return;
      }
      if (captureOutput) out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < MAX_LISTING_BYTES) err += c.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err.trim()}`));
    });
  });
}
