import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { finish } from "../src/checks/manifest.js";
import { exitCodeFor, scoreFindings, verdictFor } from "../src/score.js";
import { scan } from "../src/scan.js";
import { fixture } from "./helpers.js";

describe("scoring", () => {
  it("maps weighted sums onto GREEN / YELLOW / RED", () => {
    expect(verdictFor(0)).toBe("GREEN");
    expect(verdictFor(29)).toBe("GREEN");
    expect(verdictFor(30)).toBe("YELLOW");
    expect(verdictFor(69)).toBe("YELLOW");
    expect(verdictFor(70)).toBe("RED");
    expect(scoreFindings([{ check: "x", message: "y", score: 40 }]).verdict).toBe("YELLOW");
    expect(exitCodeFor("GREEN")).toBe(0);
    expect(exitCodeFor("YELLOW")).toBe(1);
    expect(exitCodeFor("RED")).toBe(2);
  });

  it("keeps capped finding totals consistent with check and scan scores", () => {
    const findings = Array.from({ length: 100 }, (_, i) => ({
      check: "x",
      message: `finding ${i}`,
      score: 10,
    }));
    const result = finish("x", "x", findings, 60);
    expect(result.score).toBe(60);
    expect(result.findings.reduce((sum, finding) => sum + finding.score, 0)).toBe(60);
  });

  it("promotes YELLOW to RED under --strict", async () => {
    expect(verdictFor(30, true)).toBe("RED");
    expect(verdictFor(1, true)).toBe("YELLOW");
    expect(verdictFor(0, true)).toBe("GREEN");
    const result = await scan(fixture("yellow-skill"), { strict: true });
    expect(result.verdict).toBe("RED");
    expect(result.strict).toBe(true);
  });
});

describe("cli args", () => {
  it("parses path, --json, and --strict", () => {
    expect(parseArgs(["./my-skill", "--json", "--strict"])).toMatchObject({
      target: "./my-skill",
      json: true,
      strict: true,
    });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
  });

  it("redacts URL credentials from exported parser errors", () => {
    for (const argv of [
      ["--https://arg-user:arg-pass@arg.invalid/path?arg=secret#part"],
      ["./safe", "/tmp/https:extra-user:extra-pass@extra.invalid?extra=secret#part"],
    ]) {
      let message = "";
      try {
        parseArgs(argv);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/unknown flag|unexpected argument/);
      expect(message).not.toMatch(
        /arg-user|arg-pass|arg=secret|extra-user|extra-pass|extra=secret|#part/,
      );
    }
  });
});
