import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCollectionReport, formatReport, toCollectionJson, toJson } from "../src/report.js";
import { scanCollection } from "../src/collection.js";
import { scan } from "../src/scan.js";
import { exitCodeFor } from "../src/score.js";
import { parseArgs } from "../src/args.js";
import { fixture } from "./helpers.js";

describe("fixture skills", () => {
  it("rates a clean skill GREEN", async () => {
    const result = await scan(fixture("green-skill"));
    expect(result.verdict).toBe("GREEN");
    expect(result.score).toBeLessThan(30);
    expect(result.kind).toBe("skill");
    expect(result.findings).toEqual([]);
    expect(exitCodeFor(result.verdict)).toBe(0);
  });

  it("rates secret-reading skill YELLOW", async () => {
    const result = await scan(fixture("yellow-skill"));
    expect(result.verdict).toBe("YELLOW");
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(70);
    expect(result.findings.some((f) => f.check === "secret-access")).toBe(true);
    expect(result.findings.some((f) => f.check === "phone-home")).toBe(false);
    expect(exitCodeFor(result.verdict)).toBe(1);
  });

  it("rates phone-home + postinstall skill RED", async () => {
    const result = await scan(fixture("red-skill"));
    expect(result.verdict).toBe("RED");
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.findings.some((f) => f.check === "phone-home")).toBe(true);
    expect(result.findings.some((f) => f.check === "postinstall")).toBe(true);
    expect(exitCodeFor(result.verdict)).toBe(2);
  });
});

describe("skill collections", () => {
  it("scans each direct skill separately and rejects an aggregate scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skillvet-collection-"));
    await mkdir(path.join(root, "clean"));
    await mkdir(path.join(root, "network"));
    await writeFile(
      path.join(root, "clean", "SKILL.md"),
      "---\nname: clean\ndescription: A clean skill.\n---\n",
    );
    await writeFile(
      path.join(root, "network", "SKILL.md"),
      "---\nname: network\ndescription: A networked skill.\n---\nCall https://example.test/api\n",
    );
    try {
      await expect(scan(root)).rejects.toThrow("target contains 2 direct skills");
      const result = await scanCollection(root);
      expect(result).toMatchObject({
        kind: "skill-collection",
        summary: { discovered: 2, scanned: 2, errors: 0, green: 1, yellow: 1, red: 0 },
        verdict: "YELLOW",
      });
      expect(result.entries.map((entry) => [entry.name, entry.result?.kind, entry.link])).toEqual([
        ["clean", "skill", false],
        ["network", "skill", false],
      ]);
      const json = toCollectionJson(result);
      expect(json.entries).toHaveLength(2);
      expect(json.entries.every((entry) => "result" in entry)).toBe(true);
      expect(JSON.stringify(json)).not.toContain('"evidence"');
      expect(formatCollectionReport(result)).toContain("2 discovered, 2 scanned, 0 errors");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scan arguments", () => {
  it("accepts an explicit collection scan", () => {
    expect(parseArgs(["skills", "--collection", "--profile", "claude-code"])).toMatchObject({
      target: "skills",
      collection: true,
      profile: "claude-code",
    });
  });
});

describe("scan API redaction", () => {
  it("sanitizes returned paths, finding fields, and errors", async (context) => {
    if (process.platform === "win32") {
      context.skip("this fixture requires filenames containing ':' and '?', which Windows forbids");
    }
    const base = await mkdtemp(path.join(tmpdir(), "skillvet-api-redaction-"));
    const root = path.join(
      base,
      "https:path-user:path-pass@example.com?path=secret#part",
    );
    await mkdir(root);
    await writeFile(
      path.join(root, "SKILL.md"),
      "---\nname: api-redaction\ndescription: API redaction fixture\n---\n",
    );
    await writeFile(
      path.join(root, "ipc:file-user:file-pass@channel?file=secret#part.js"),
      'eval("safe literal");\n',
    );
    try {
      const result = await scan(root);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("example.com");
      expect(serialized).not.toMatch(
        /path-user|path-pass|path=secret|file-user|file-pass|file=secret|#part/,
      );

      const missing = path.join(
        base,
        "https:error-user:error-pass@example.com?error=secret#part",
      );
      let message = "";
      try {
        await scan(missing);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("path not found");
      expect(message).toContain("example.com");
      expect(message).not.toMatch(/error-user|error-pass|error=secret|#part/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("report", () => {
  it("emits a JSON document with verdict and checks when --json", async () => {
    const result = await scan(fixture("red-skill"));
    const parsed = JSON.parse(formatReport(result, { json: true })) as ReturnType<typeof toJson>;
    expect(parsed.verdict).toBe("RED");
    expect(parsed.score).toBeGreaterThanOrEqual(70);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.checks.map((c) => c.id)).toEqual([
      "phone-home",
      "secret-access",
      "postinstall",
      "obfuscation",
      "binaries",
      "scan-coverage",
      "manifest",
    ]);
  });

  it("redacts credential-bearing targets at the reporting boundary", async () => {
    const result = await scan(fixture("green-skill"));
    for (const target of [
      "https://user:pass@example.com/archive.tgz?token=secret#part",
      "/tmp/https:path-user:path-pass@example.com?path=secret#part",
    ]) {
      result.target = target;
      const table = formatReport(result);
      const json = formatReport(result, { json: true });
      expect(`${table}\n${json}`).toContain("example.com");
      expect(`${table}\n${json}`).not.toMatch(
        /user|pass|token=secret|path=secret|#part/,
      );
    }
  });

  it("redacts credential-bearing finding fields at the reporting boundary", async () => {
    const result = await scan(fixture("green-skill"));
    const finding = {
      check: "phone-home",
      message: "endpoint ipc:opaque-user:opaque-pass@channel/run?key=secret#part",
      evidence: 'fetch("h\tttps://web-user:web-pass@example.com/a?token=secret#part")',
      file: "ipc:file-user:file-pass@channel/run?file=secret#part.js",
      score: 40,
    };
    result.resolvedPath = "/tmp/https:path-user:path-pass@example.com/a?path=secret#part";
    result.findings.push(finding);
    result.checks[0]?.findings.push(finding);
    const table = formatReport(result);
    const json = formatReport(result, { json: true });
    expect(`${table}\n${json}`).toContain("example.com/a");
    expect(`${table}\n${json}`).not.toMatch(
      /opaque-user|opaque-pass|web-user|web-pass|file-user|file-pass|path-user|path-pass|key=secret|token=secret|file=secret|path=secret|#part/,
    );
  });
});
