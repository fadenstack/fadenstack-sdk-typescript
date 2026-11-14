import type { AgentProfile } from "@fadenstack/client";

/** Whether local skills are on for an agent, and why (shown to the user when they are not). */
export interface LocalSkillsDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Decides whether an agent may use skills kept on the device. An extension with further modes replaces the core policy with its
 * own; local configuration can only tighten this, never widen it. .NET: `ILocalSkillsPolicy`.
 */
export interface LocalSkillsPolicy {
  decide(profile: AgentProfile): LocalSkillsDecision;
}

/**
 * The core rule, the shape of the local MCP rule: the profile's `local_skills.mode` is `allow`, or the user's `developer_mode` is
 * on. Absent or unknown means off. A standalone agent's profile says `allow` unless the person switched local skills off, and
 * the machine policy has already turned the profile off where it forbids skills (`AgentBuilder.useMachinePolicy`). .NET:
 * `CoreLocalSkillsPolicy`.
 */
export const coreLocalSkillsPolicy: LocalSkillsPolicy = Object.freeze({
  decide(profile: AgentProfile): LocalSkillsDecision {
    const settings = profile.localSkills;
    const mode = settings?.mode;
    if (mode === "allow") return { allowed: true, reason: "The agent allows local skills." };
    if (settings?.developerMode === true) return { allowed: true, reason: "Developer mode." };
    if (mode === undefined || mode === "" || mode === "disable") return { allowed: false, reason: "The agent does not allow local skills." };
    return { allowed: false, reason: `The agent's local skills mode '${mode}' needs a policy this app does not have.` };
  },
});
