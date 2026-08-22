import type { ScanProfile } from "./types.js";

export interface ScanProfileDefinition {
  id: ScanProfile;
  skillFrontmatterFields: readonly string[];
}

const PORTABLE_AGENT_SKILL_FIELDS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

export const SCAN_PROFILES: Record<ScanProfile, ScanProfileDefinition> = {
  "portable-agent-skill": {
    id: "portable-agent-skill",
    skillFrontmatterFields: PORTABLE_AGENT_SKILL_FIELDS,
  },
  "claude-code": {
    id: "claude-code",
    skillFrontmatterFields: [
      ...PORTABLE_AGENT_SKILL_FIELDS,
      "argument-hint",
      "disable-model-invocation",
      "user-invocable",
      "context",
      "agent",
      "model",
      "hooks",
    ],
  },
};

export function scanProfile(profile: ScanProfile): ScanProfileDefinition {
  return SCAN_PROFILES[profile];
}
