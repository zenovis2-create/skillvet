import { safeGet } from "./safe-http.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_API_BYTES = 2 * 1024 * 1024;

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export interface GitHubTarget {
  owner: string;
  repo: string;
  treeParts?: string[];
}

export function parseGitHubTarget(raw: string): GitHubTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "github.com") return undefined;

  const rawPath = raw.match(/^https?:\/\/[^/]+([^?#]*)/i)?.[1] ?? "";
  const parts = rawPath.split("/").slice(1);
  while (parts.at(-1) === "") parts.pop();
  if (parts.length < 2 || parts.some((part) => part === "")) {
    throw new Error("invalid GitHub repository URL");
  }
  const decoded = parts.map(decodeGitHubSegment);
  const owner = decoded[0] ?? "";
  const repo = (decoded[1] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) throw new Error("invalid GitHub repository URL");
  if (decoded.length === 2) return { owner, repo };

  const mode = decoded[2];
  if (mode === "blob") {
    throw new Error("GitHub blob URLs are not supported; scan a repository or tree URL");
  }
  if (mode !== "tree" || decoded.length < 4) {
    throw new Error("unsupported GitHub URL; scan a repository or tree URL");
  }
  return { owner, repo, treeParts: decoded.slice(3) };
}

function decodeGitHubSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error("invalid percent-encoding in GitHub URL");
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    throw new Error("invalid path segment in GitHub URL");
  }
  return decoded;
}

export function selectGitHubRef(
  treeParts: string[],
  candidateRefs: string[],
): { ref: string; subdir: string } | undefined {
  const matches = candidateRefs
    .map((candidate) => candidate.replace(/^refs\/(?:heads|tags)\//, ""))
    .filter((candidate) => {
      const refParts = candidate.split("/");
      return (
        refParts.length <= treeParts.length &&
        refParts.every((part, index) => treeParts[index] === part)
      );
    })
    .sort(
      (a, b) =>
        b.split("/").length - a.split("/").length || b.length - a.length,
    );
  const ref = matches[0];
  if (!ref) return undefined;
  return {
    ref,
    subdir: treeParts.slice(ref.split("/").length).join("/"),
  };
}

export async function resolveGitHubTreeReference(
  owner: string,
  repo: string,
  treeParts: string[],
): Promise<{ sha: string; subdir: string }> {
  const first = treeParts[0];
  if (!first) throw new Error("GitHub tree URL is missing a ref");

  let selected: { ref: string; subdir: string } | undefined;
  if (/^[0-9a-f]{7,40}$/i.test(first)) {
    selected = { ref: first, subdir: treeParts.slice(1).join("/") };
  } else {
    const [heads, tags] = await Promise.all([
      fetchGitHubRefs(owner, repo, "heads", first),
      fetchGitHubRefs(owner, repo, "tags", first),
    ]);
    selected = selectGitHubRef(treeParts, [...heads, ...tags]);
  }
  if (!selected) {
    throw new Error("GitHub tree URL does not contain a resolvable branch or tag");
  }
  return {
    sha: await fetchGitHubCommitSha(owner, repo, selected.ref),
    subdir: selected.subdir,
  };
}

async function fetchGitHubRefs(
  owner: string,
  repo: string,
  kind: "heads" | "tags",
  prefix: string,
): Promise<string[]> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/matching-refs/${kind}/${encodeURIComponent(prefix)}`;
  const response = await fetchGitHubApi(endpoint);
  if (!response.ok) {
    throw new Error(`GitHub ref lookup failed with HTTP ${response.status}`);
  }
  const raw = parseJson(response.body);
  if (!Array.isArray(raw)) throw new Error("GitHub ref lookup returned invalid data");
  return raw.flatMap((item) =>
    isRecord(item) && typeof item.ref === "string" ? [item.ref] : [],
  );
}

async function fetchGitHubCommitSha(
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const response = await fetchGitHubApi(endpoint);
  if (!response.ok) {
    throw new Error(`GitHub commit lookup failed with HTTP ${response.status}`);
  }
  const raw = parseJson(response.body);
  if (!isRecord(raw) || typeof raw.sha !== "string" || !/^[0-9a-f]{40}$/i.test(raw.sha)) {
    throw new Error("GitHub commit lookup returned invalid data");
  }
  return raw.sha;
}

async function fetchGitHubApi(url: string) {
  return safeGet(url, {
    headers: GITHUB_API_HEADERS,
    maxBytes: MAX_API_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new Error("GitHub API returned invalid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
