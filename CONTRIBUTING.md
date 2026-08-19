# Contributing to skillvet

Thanks for helping keep agent skills and MCP servers from being a free-for-all.

## Setup

Node 22 or newer.

```bash
npm install
npm test
npm run lint
npm run build
```

Run the scanner against the bundled fixtures:

```bash
npx tsx src/cli.ts test/fixtures/green-skill
npx tsx src/cli.ts test/fixtures/yellow-skill
npx tsx src/cli.ts test/fixtures/red-skill --json
```

## What belongs here

skillvet is a **static** scanner. It reads files. It does not execute the skill under test, talk to a database, or ship a web UI.

Good PRs:

- A new check with a fixture (or a temp-dir unit test) and a score that still lands the three fixture skills in GREEN / YELLOW / RED
- Tighter detectors that cut false positives
- Docs that match the actual CLI output

Keep runtime dependencies minimal. `yaml` is the sole runtime dependency and has no
transitive packages; it provides standards-compliant, fail-closed frontmatter parsing.
Any additional runtime package needs a security and maintenance justification. Dev
tooling stays at TypeScript, vitest, tsx, and `@types/node`.

## Scoring

Weighted findings sum to a score capped at 100:

| Verdict | Score | Exit code |
| --- | --- | --- |
| GREEN | `< 30` | 0 |
| YELLOW | `30–69` | 1 |
| RED | `≥ 70` | 2 |

`--strict` treats any finding as YELLOW and score ≥ 30 as RED.

`preinstall` / `install` / `postinstall` must stay **at least YELLOW** on their own.

## Pull requests

1. Add or update tests for the behavior you change.
2. Run `npm test` and `npm run lint`.
3. Use the PR template. Say how the fixture verdicts still hold if you touched weights.
