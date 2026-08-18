# skillvet

Supply-chain security scanner for AI agent skills and MCP servers. One command. A **RED / YELLOW / GREEN** verdict.

[![stars](https://img.shields.io/github/stars/zenovis2-create/skillvet?style=flat)](https://github.com/zenovis2-create/skillvet)
[![CI](https://img.shields.io/github/actions/workflow/status/skillvet/skillvet/ci.yml?label=CI)](https://github.com/zenovis2-create/skillvet/actions)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npx skillvet ./my-skill
```

Zero runtime dependencies. Node 20+. Does not execute the skill.

## Install

```bash
npx skillvet ./my-skill
npx skillvet https://github.com/some-user/some-skill
npx skillvet ./my-mcp-server --json
```

Or pin it:

```bash
npm i -D skillvet
npx skillvet ./my-skill --strict
```

## What it checks

| Check | What gets flagged |
| --- | --- |
| **phone-home** | `http(s)` / `ws(s)` / IPC URLs to hosts not declared in the skill, plus `child_process`, `eval(`, `Function(` |
| **secret-access** | `~/.ssh`, `~/.aws`, `~/.config`, `*_TOKEN`, `*_KEY`, `GITHUB_TOKEN` |
| **postinstall** | npm `preinstall` / `install` / `postinstall` — automatic **YELLOW** at least |
| **obfuscation** | `Buffer.from(..., 'base64')`, `atob`, hex-string `eval`, minified sources |
| **binaries** | non-whitelisted executables (ELF / PE / Mach-O / `.exe` / `.so` / …) |
| **manifest** | skills need `SKILL.md` with `name` + `description`; MCP servers need a valid `mcp.json` or `package.json` MCP entry |

Declare hosts the skill is allowed to call:

```yaml
---
name: ship-it
description: Opens a pull request on GitHub.
allowed-domains:
  - api.github.com
---
```

`package.json` `homepage` / `repository` count as declared too.

## Scoring

Weighted findings sum to 0–100.

| Verdict | Score | Exit code |
| --- | --- | --- |
| **GREEN** | `< 30` | `0` |
| **YELLOW** | `30–69` | `1` |
| **RED** | `≥ 70` | `2` |

`--strict` is for CI: any finding is YELLOW, and score ≥ 30 becomes RED.

## Example output

### GREEN — clean local skill

```
skillvet 0.1.0   scan  ./my-skill
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       0     GREEN    —
secret-access    0     GREEN    —
postinstall      0     GREEN    —
obfuscation      0     GREEN    —
binaries         0     GREEN    —
manifest         0     GREEN    —

VERDICT  GREEN   0/100
```

### YELLOW — reads secrets, no network

```
skillvet 0.1.0   scan  ./env-doctor
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       0     GREEN    —
secret-access    +40   YELLOW   reads ~/.ssh  (+1 more)
postinstall      0     GREEN    —
obfuscation      0     GREEN    —
binaries         0     GREEN    —
manifest         0     GREEN    —

findings
  • reads ~/.ssh  index.js:5
  • references GITHUB_TOKEN  index.js:6

VERDICT  YELLOW   40/100
```

### RED — phones home + postinstall hook

```
skillvet 0.1.0   scan  ./helpful-notes
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       +40   YELLOW   undeclared outbound host exfil.attacker.invalid
secret-access    0     GREEN    —
postinstall      +35   YELLOW   package.json scripts.postinstall runs automatically on install
obfuscation      0     GREEN    —
binaries         0     GREEN    —
manifest         0     GREEN    —

findings
  • undeclared outbound host exfil.attacker.invalid  index.js:1
  • package.json scripts.postinstall runs automatically on install  package.json

VERDICT  RED   75/100
```

JSON for pipelines:

```bash
npx skillvet ./my-skill --json
```

```json
{
  "verdict": "RED",
  "score": 75,
  "exitCode": 2,
  "findings": [
    { "check": "phone-home", "message": "undeclared outbound host exfil.attacker.invalid" },
    { "check": "postinstall", "message": "package.json scripts.postinstall runs automatically on install" }
  ]
}
```

## Why now?

August 2026: researchers flagged about **7,600 malicious GitHub repositories**, **800+** of them posing as AI Skills or MCP servers. A GitHub takeover of the 25k-star Blender MCP repo showed how fast a “just paste this skill” habit turns into a supply-chain incident.

Developers still drop random `SKILL.md` folders and MCP packages into agents with no review. skillvet is the five-second check before that happens.

It will not catch a clever enough adversary. It will catch the stuff that is already in the wild: install hooks, stolen tokens, mystery binaries, and a `fetch` to a domain the skill never declared.

## Library

```ts
import { scan, exitCodeFor } from "skillvet";

const result = await scan("./my-skill", { strict: true });
console.log(result.verdict, result.score);
process.exit(exitCodeFor(result.verdict));
```

## License

MIT
