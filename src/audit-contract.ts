import {
  CLAUDE_CODE_RULESET,
  WORKSPACE_INSTRUCTION_RULESET,
} from "./audit-rules.js";
import type { AuditProvider } from "./audit-types.js";

export const AUDIT_JSON_SCHEMA_VERSION = 1 as const;

export const AUDIT_FINDING_ID_POLICY = {
  reuse: "forbidden",
  semanticChange: "forbidden",
  retirement: "deprecated",
} as const;

export type AuditFindingIdStatus = "active" | "deprecated";

export interface AuditFindingIdStatusEntry {
  id: string;
  status: AuditFindingIdStatus;
}

// Retired IDs remain here with status: "deprecated" rather than being reused.
export const DEPRECATED_AUDIT_FINDING_IDS: readonly string[] = [];

export function auditRulesetIds(
  provider: Pick<AuditProvider, "behaviorRuleset">,
): string[] {
  const ids = [WORKSPACE_INSTRUCTION_RULESET.id];
  if (provider.behaviorRuleset !== "unknown") ids.push(provider.behaviorRuleset);
  return sortedUnique(ids, "ruleset");
}

export function auditFindingIdStatuses(): AuditFindingIdStatusEntry[] {
  const active = [
    ...WORKSPACE_INSTRUCTION_RULESET.checks,
    ...CLAUDE_CODE_RULESET.checks,
  ].map(({ id }) => ({ id, status: "active" as const }));
  const deprecated = DEPRECATED_AUDIT_FINDING_IDS.map((id) => ({
    id,
    status: "deprecated" as const,
  }));
  const entries = [...active, ...deprecated];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`duplicate audit finding ID: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function sortedUnique(values: readonly string[], kind: string): string[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error(`duplicate audit ${kind} ID`);
  return unique.sort((left, right) => left.localeCompare(right));
}
