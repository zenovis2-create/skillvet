import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ResolvedTarget {
  path: string;
  cleanup?: () => Promise<void>;
}

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
      return { path: subdir ? path.join(root, subdir) : root, cleanup };
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
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

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed (${url}): ${res.status} ${res.statusText}`);
  }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function assertSafeTar(tarPath: string): Promise<void> {
  const listing = await run("tar", ["-tzf", tarPath]);
  for (const member of listing.split("\n")) {
    if (!member) continue;
    if (member.startsWith("/") || member.includes("..")) {
      throw new Error(`refusing archive member outside target: ${member}`);
    }
  }
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

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err.trim()}`));
    });
  });
}


