import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
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
});
