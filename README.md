# skillvet

Supply-chain security scanner for AI agent skills and MCP servers. One command. A **RED / YELLOW / GREEN** verdict.

[![stars](https://img.shields.io/github/stars/zenovis2-create/skillvet?style=flat)](https://github.com/zenovis2-create/skillvet)
[![CI](https://img.shields.io/github/actions/workflow/status/zenovis2-create/skillvet/ci.yml?label=CI)](https://github.com/zenovis2-create/skillvet/actions)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npx skillvet ./my-skill
```

Zero runtime dependencies. Node 22+. Does not execute the skill.

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
| **phone-home** | `http(s)` / `ws(s)` / IPC URLs in source and `SKILL.md`, plus `child_process`, `eval(`, `Function(` |
| **secret-access** | `~/.ssh`, `~/.aws`, `~/.config`, `*_TOKEN`, `*_KEY`, `GITHUB_TOKEN`, including agent instructions |
| **postinstall** | npm install/package lifecycle hooks such as `preinstall`, `postinstall`, `prepare`, `prepublish`, and `prepack` |
| **obfuscation** | `Buffer.from(..., 'base64')`, `atob`, hex-string `eval`, minified sources |
| **binaries** | executables and ELF / PE / Mach-O magic, even when disguised with an asset extension |
| **scan-coverage** | source-shaped files that could not be inspected, including files over 1 MB |
| **manifest** | Agent Skills name/description rules and MCP `server.json`, `mcp.json`, or `package.json` entries |

Declare hosts the skill says it needs to call:

```yaml
---
name: ship-it
description: Opens a pull request on GitHub.
allowed-domains:
  - api.github.com
---
```

Declarations are attacker-controlled metadata, so they lower a host finding to 5 points but do not hide it. `package.json` `homepage` and `repository` values are never treated as network policy.

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
skillvet 0.1.1   scan  ./my-skill
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       0     GREEN    —
secret-access    0     GREEN    —
postinstall      0     GREEN    —
obfuscation      0     GREEN    —
binaries         0     GREEN    —
scan-coverage    0     GREEN    —
manifest         0     GREEN    —

VERDICT  GREEN   0/100
```

### YELLOW — reads secrets, no network

```
skillvet 0.1.1   scan  ./env-doctor
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       0     GREEN    —
secret-access    +40   YELLOW   reads ~/.ssh  (+1 more)
postinstall      0     GREEN    —
obfuscation      0     GREEN    —
binaries         0     GREEN    —
scan-coverage    0     GREEN    —
manifest         0     GREEN    —

findings
  • reads ~/.ssh  index.js:5
  • references GITHUB_TOKEN  index.js:6

VERDICT  YELLOW   40/100
```

### RED — phones home + postinstall hook

```
skillvet 0.1.1   scan  ./helpful-notes
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       +40   YELLOW   undeclared outbound host exfil.attacker.invalid
secret-access    0     GREEN    —
postinstall      +35   YELLOW   package.json scripts.postinstall is an npm lifecycle hook
obfuscation      0     GREEN    —
binaries         0     GREEN    —
scan-coverage    0     GREEN    —
manifest         0     GREEN    —

findings
  • undeclared outbound host exfil.attacker.invalid  index.js:1
  • package.json scripts.postinstall is an npm lifecycle hook  package.json

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
    { "check": "postinstall", "message": "package.json scripts.postinstall is an npm lifecycle hook" }
  ]
}
```

## Why now?

In August 2026, [Island reported about 7,600 malicious GitHub repositories](https://www.island.io/blog/your-ai-can-be-given-secret-instructions-in-plain-english), including more than 800 posing as AI Skills or MCP servers.

Developers still drop random `SKILL.md` folders and MCP packages into agents with no review. skillvet is the five-second check before that happens.

It will not catch a clever enough adversary. It will catch the stuff that is already in the wild: install hooks, stolen tokens, mystery binaries, and a `fetch` to a domain the skill never declared.

## Security model

Remote downloads are capped at 25 MB, archive contents at 100 MB and 10,000 entries, and network/archive commands at 30 seconds. Archive paths and links are rejected before extraction. GitHub tree subdirectories are resolved through their real paths and must remain under the extracted repository root.

skillvet is a static heuristic scanner, not a sandbox or proof of safety. Review findings and source before installation. See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Library

```ts
import { scan, exitCodeFor } from "skillvet";

const result = await scan("./my-skill", { strict: true });
console.log(result.verdict, result.score);
process.exit(exitCodeFor(result.verdict));
```

## License

MIT
