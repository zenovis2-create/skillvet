# skillvet

Static evidence for what an agent workspace will load, expose, and cost — plus
supply-chain scanning for skills and MCP servers.

[![stars](https://img.shields.io/github/stars/zenovis2-create/skillvet?style=flat)](https://github.com/zenovis2-create/skillvet)
[![CI](https://img.shields.io/github/actions/workflow/status/zenovis2-create/skillvet/ci.yml)](https://github.com/zenovis2-create/skillvet/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

`skillvet audit` verifies the effective agent configuration, not just the files
that exist. It applies bundled instruction-loader rules, declared provider
versions, and context measurements to local workspace evidence. `skillvet scan`
remains the separate supply-chain scanner for a skill or MCP target.

Node 22+. Uses the zero-transitive-dependency `yaml` parser for standards-compliant
frontmatter validation. Does not execute the skill.

## Audit effective configuration

For an interactive local audit, opt in to provider-version detection:

```bash
npx skillvet audit . --detect-provider-version
```

For CI, declare the installed provider version and require reviewed coverage:

```bash
npx skillvet audit . \
  --provider claude-code@<version> \
  --fail-on=security \
  --require-reviewed \
  --json
```

The report makes loader semantics reviewable instead of treating every discovered
file as equally active:

- Codex `AGENTS.override.md` replacement and inherited instruction bytes
- Codex profile and `skills.config` enabled/disabled state
- Claude project-memory ambiguity and in-workspace `@import` chains
- provider-version coverage, including explicit partial and unreviewed boundaries

`audit --json` has a versioned CI contract with a schema version, tool version,
sorted ruleset IDs, and stable/deprecated finding-ID states. See the
[audit JSON contract](./docs/AUDIT_JSON_CONTRACT.md) and
[GitHub Action guide](./docs/GITHUB_ACTION.md).

## Scan skills and MCP servers

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

## Audit evidence and boundaries

The instruction ledger makes startup-context work measurable instead of deleting prose
blindly:

- Claude: one project-memory location (`CLAUDE.md` or `.claude/CLAUDE.md`),
  `CLAUDE.local.md`, unscoped/path-scoped rules, and in-workspace `@file` imports.
  `main:start` distinguishes source bytes from a conservative expanded-source estimate
  based on unique imports. Both documented project-memory locations are flagged as
  ambiguous rather than summed.
- Codex: each in-workspace `AGENTS.md` or `AGENTS.override.md`, the effective file at
  each directory level, and the within-target inherited chain. An override is reported
  because it replaces, rather than appends to, `AGENTS.md` at that level.

The workspace target is the project boundary for this measurement. Audit the Codex home
separately to inspect its global layer and configured instruction cap.

Use the documented Codex default only as an explicit measurement assumption; override
it when the active configuration differs:

```bash
npx skillvet audit . --assume-codex-project-doc-max-bytes=32768
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
environment interpolation, candidate skill-listing overflow, Codex override precedence,
within-target project-instruction cap risk, and conflicting Claude project-memory
locations. `CLAUDE.md` files over the documented 200-line guidance are advisory
findings, not CI-eligible failures.
The load ledger also follows in-workspace `CLAUDE.md` imports and marks unresolved or
external edges as partial coverage instead of reading outside the declared workspace.
The JSON schema separates raw `observations`, evaluated `findings`, coverage, and
`suppressedEvaluations` so a CI parser cannot mistake syntactic facts for validated
runtime behavior.

The modeled instruction behavior is based on the official [Codex instruction-file
documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and
[Claude Code memory documentation](https://code.claude.com/docs/en/memory). The report
is static evidence, not a claim that every global/runtime source was loaded in a live
session.

## Audit a Codex home

Codex installations have a different load surface: `config.toml`, global `AGENTS.md` /
`AGENTS.override.md`, direct skill directories, `skills.config` overrides, plugins, and
MCP servers. Use the dedicated
local-only mode instead of treating the entire `skills` directory as one skill:

```bash
npx skillvet audit codex "$CODEX_HOME" --json
```

It does not launch Codex, start MCP servers, download plugins, or execute skill
content. It reports direct skill count, enabled/disabled overrides, filesystem links
and junctions, discovery-metadata byte count, configured MCP transport/endpoints,
global instruction precedence, `project_doc_max_bytes`, and disabled plugins that
retain child settings or trusted-hook state. Unsupported or unreadable modeled surfaces
are reported as `PARTIAL` coverage rather than folded into a security verdict.

High-severity configuration contradictions or unresolved override targets return exit
code 2; partial coverage returns exit code 3. Warnings remain visible in the report
without making the configuration audit fail.

## Scan a skill collection

When a directory contains multiple direct child `SKILL.md` folders, scan each skill
independently:

```bash
npx skillvet scan "$CODEX_HOME/skills" --collection --no-color
```

Without `--collection`, `scan` rejects such a target with a concrete count and hint
instead of combining unrelated skills, documentation, and link coverage into one
misleading score. Collection JSON emits one result per skill and intentionally omits
raw finding evidence from nested results, keeping large reports safer to store and
inspect on endpoint-protected systems. Individual-skill JSON preserves the full
existing evidence contract.

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
