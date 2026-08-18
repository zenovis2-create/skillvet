import { describe, expect, it } from "vitest";
import { formatReport, toJson } from "../src/report.js";
import { scan } from "../src/scan.js";
import { exitCodeFor } from "../src/score.js";
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
      "manifest",
    ]);
  });
});
