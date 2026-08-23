# Audit JSON contract

`skillvet audit <workspace> --json` emits the versioned CI contract below. This
document applies to the workspace audit report; the package's `scan` report and
the dedicated `audit codex` report retain their own result shapes.

## Versioning

- `schemaVersion` is the report schema version. The current contract is `1`.
- `toolVersion` is the installed `skillvet` package version. It is not a schema
  version.
- `rulesetIds` is a sorted list of the rulesets that evaluated the report. The
  workspace-instruction ruleset is always present. A provider behavior ruleset
  is present only when a declared or detected provider version selected it.

## Finding IDs

`findingIdStatuses` is sorted by ID and records every built-in audit finding ID.
An active ID has `status: "active"`. A retired ID remains in the list with
`status: "deprecated"`.

Finding IDs are append-only contract identifiers:

1. An ID is never reused for a different meaning.
2. An existing ID's meaning is never silently changed.
3. Retirement changes its status to `deprecated`; it does not delete or reuse
   the identifier.

`findingIdPolicy` makes those three rules visible to CI consumers, while the
canonical contract fixture prevents an accidental schema or ordering change.
