import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const MAX_LISTING_BYTES = 5 * 1024 * 1024;

export async function extractSafeTar(
  archivePath: string,
  destination: string,
): Promise<void> {
  const listing = await run("tar", ["-tzf", archivePath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveMembers(listing.split("\n").filter(Boolean));
  const verbose = await run("tar", ["-tvzf", archivePath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveListing(verbose, "tar");
  await run("tar", ["-xOzf", archivePath], {
    captureOutput: false,
    maxOutputBytes: MAX_EXPANDED_BYTES,
  });
  await run("tar", ["-xzf", archivePath, "-C", destination]);
}

export async function extractSafeZip(
  archivePath: string,
  destination: string,
): Promise<void> {
  const listing = await run("unzip", ["-Z1", archivePath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveMembers(listing.split("\n").filter(Boolean));
  const verbose = await run("unzip", ["-Z", "-l", archivePath], {
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  validateArchiveListing(verbose, "zip");
  await run("unzip", ["-p", archivePath], {
    captureOutput: false,
    maxOutputBytes: MAX_EXPANDED_BYTES,
  });
  await run("unzip", ["-q", archivePath, "-d", destination]);
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
      /^[a-zA-Z]:/.test(normalized) ||
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

export async function selectExtractedRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const only = entries[0];
  if (entries.length === 1 && only?.isDirectory()) {
    return path.join(dir, only.name);
  }
  return dir;
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
    let errBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      if (failure) return;
      failure = new Error(`${cmd} timed out after ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        failure = new Error(`${cmd} output exceeds ${maxOutputBytes} bytes`);
        child.kill("SIGKILL");
        return;
      }
      if (captureOutput) out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= MAX_LISTING_BYTES) err += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
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
