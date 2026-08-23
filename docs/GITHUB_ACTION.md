# GitHub Action

The root action runs the workspace audit as a thin consumer of the versioned
JSON contract. It installs the pinned package dependencies from the action's
checked-out revision, writes the JSON report to the runner temporary directory,
and publishes a small job summary plus typed outputs. It does not upload the
workspace audit report.

Pin the action to an immutable repository commit:

```yaml
- uses: zenovis2-create/skillvet@<commit-sha>
  with:
    provider: claude-code@2.1.239
    fail-on: security
    require-reviewed: "true"
```

The action preserves the audit exit code. `2` means an eligible selected finding
failed; `3` means the requested provider-review gate was not evaluable. Its
outputs are `report-path`, `schema-version`, `tool-version`, `status`,
`exit-code`, and `finding-count`.

Supply an explicit `provider` for CI. Version detection is intentionally not an
action default, because a reproducible CI result must declare the provider it is
reviewing.
