# skillvet

Supply-chain scanner for AI agent skills and MCP servers, plus a CI-grade static audit for Claude Code workspaces.

[![stars](https://img.shields.io/github/stars/zenovis2-create/skillvet?style=flat)](https://github.com/zenovis2-create/skillvet)
[![CI](https://img.shields.io/github/actions/workflow/status/zenovis2-create/skillvet/ci.yml)](https://github.com/zenovis2-create/skillvet/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npx skillvet ./my-skill
```

Node 22+. Uses the zero-transitive-dependency `yaml` parser for standards-compliant
frontmatter validation. Does not execute the skill.

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

## Audit a Claude Code workspace

`scan` remains the package supply-chain scanner. `audit` is a separate, local-only
workspace command: it reports load-surface facts, configured hooks, and version-gated
Claude Code findings without downloading or executing workspace content.

For an interactive local audit, opt in to version detection:

```bash
npx skillvet audit . --detect-provider-version
```

For CI, declare the exact installed version instead. This makes the report reproducible
and makes review coverage a deliberate gate:

```bash
npx skillvet audit . \
  --provider claude-code@<version> \
  --fail-on=security \
  --require-reviewed
```

`audit` never assumes a provider version. Without one it reports file facts and
configuration observations, marks coverage `PARTIAL`, and does not turn version-gated
behavior into findings. A version newer than the bundled documentation snapshot remains
useful but is labeled `unreviewed`: findings are shown with CI eligibility disabled.

| Audit exit code | Meaning |
| --- | --- |
| `0` | No eligible failure. This is not a claim that the workspace is GREEN. |
| `2` | An eligible selected finding failed. |
| `3` | A requested review or `--fail-on` gate could not be evaluated. |

`--fail-on=context,hook` or `--fail-on=MATCH_ALL_HOOK` selects an opt-in gate.
Use `--fail-on-unreviewed` only when you intentionally want an unreviewed provider
version to participate in that gate.

Current deterministic rules cover modeled wildcard hooks, public HTTP hooks, header
environment interpolation, oversized `CLAUDE.md`, and candidate skill-listing overflow.
The load ledger also follows in-workspace `CLAUDE.md` imports and marks unresolved or
external edges as partial coverage instead of reading outside the declared workspace.
The JSON schema separates raw `observations`, evaluated `findings`, coverage, and
`suppressedEvaluations` so a CI parser cannot mistake syntactic facts for validated
runtime behavior.

## Profiles

The default `scan` profile remains `portable-agent-skill`, which validates the six-field
Agent Skills upload schema. Use the Claude Code profile when a local skill uses Claude
Code-only frontmatter such as `argument-hint` or `disable-model-invocation`:

```bash
npx skillvet scan ./my-skill --profile claude-code
```

This profile split preserves strict pre-upload validation instead of silently accepting
fields that a portable Agent Skill upload would reject.

## What it checks

| Check | What gets flagged |
| --- | --- |
| **phone-home** | `http(s)` / `ws(s)` / IPC URLs in source and `SKILL.md`, plus `child_process`, `eval(`, `Function(` |
| **secret-access** | `~/.ssh`, `~/.aws`, `~/.config`, `*_TOKEN`, `*_KEY`, `GITHUB_TOKEN`, including agent instructions |
| **postinstall** | npm install/package lifecycle hooks, including `preprepare` / `postprepare`, plus implicit `binding.gyp` node-gyp builds |
| **obfuscation** | `Buffer.from(..., 'base64')`, `atob`, hex-string `eval`, minified sources |
| **binaries** | executables and ELF / PE / Mach-O / WebAssembly magic, even when disguised with an asset extension |
| **scan-coverage** | source-shaped files and filesystem entries that could not be inspected, including files over 1 MB, symbolic links, and excluded directories |
| **manifest** | Agent Skills name/description rules and MCP `server.json`, `mcp.json`, or `package.json` entries |

Declare hosts the skill says it needs to call:

```yaml
---
name: ship-it
description: Opens a pull request on GitHub.
metadata:
  skillvet.allowed-domains: "api.github.com"
---
```

Declarations are attacker-controlled metadata, so a declared host remains a 35-point **YELLOW** finding instead of being hidden. Secret access combined with any outbound host is scored **RED**. `package.json` `homepage` and `repository` values are never treated as network policy.

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

```bash
npx skillvet ./green-skill
```

```
skillvet 0.2.0   scan  ./green-skill
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

```bash
npx skillvet ./yellow-skill
```

```
skillvet 0.2.0   scan  ./yellow-skill
kind skill

check            pts   status   notes
──────────────── ───   ──────   ────────────────────────────────────────────
phone-home       0     GREEN    —
secret-access    +45   YELLOW   reads ~/.ssh  (+1 more)
postinstall      0     GREEN    —
obfuscation      0     GREEN    —
binaries         0     GREEN    —
scan-coverage    0     GREEN    —
manifest         0     GREEN    —

findings
  • reads ~/.ssh  index.js:5
  • references GITHUB_TOKEN  index.js:6

VERDICT  YELLOW   45/100
```

### RED — phones home + postinstall hook

```bash
npx skillvet ./red-skill
```

```
skillvet 0.2.0   scan  ./red-skill
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
npx skillvet ./red-skill --json \
  | jq '{verdict, score, exitCode, findings: [.findings[] | {check, message}]}'
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

In July 2026, [Island reported about 7,600 malicious GitHub repositories](https://www.island.io/blog/your-ai-can-be-given-secret-instructions-in-plain-english), including more than 800 posing as AI Skills or MCP servers.

Developers still drop random `SKILL.md` folders and MCP packages into agents with no review. skillvet is the five-second check before that happens.

It will not catch a clever enough adversary. It will catch the stuff that is already in the wild: install hooks, stolen tokens, mystery binaries, and a `fetch` to a domain the skill never declared.

## Security model

Remote downloads are capped at 25 MB, archive contents at 100 MB and 10,000 entries, and network/archive commands at 30 seconds. Remote URLs and every redirect hop are limited to public HTTP(S) addresses, with the validated DNS address pinned to the connection; credentials, query strings, and fragments are removed from reports. Archive paths and links are rejected before extraction. GitHub tree refs are resolved through GitHub's API to immutable commit SHAs, including branch names containing `/`; subdirectories must remain under the extracted repository root. Generic tar archives with mixed top-level entries are scanned from the full extraction root.

Remote tar/ZIP scans require the host `tar` and `unzip` commands (macOS or Linux).

skillvet is a static heuristic scanner, not a sandbox or proof of safety. Review findings and source before installation. See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Library

```ts
import { audit, auditExitCode, scan, exitCodeFor } from "skillvet";

const result = await scan("./my-skill", { strict: true });
console.log(result.verdict, result.score);
process.exit(exitCodeFor(result.verdict));

const workspace = await audit(".", { provider: "claude-code@2.1.239" });
process.exit(auditExitCode(workspace, { failOn: ["security"], requireReviewed: true }));
```

## License

MIT
