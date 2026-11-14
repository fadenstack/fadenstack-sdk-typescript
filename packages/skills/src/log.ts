import { defineLog } from "@fadenstack/client";

/** The category of everything the skills module logs. */
export const SKILLS_LOG_CATEGORY = "Fadenstack.Skills";

/**
 * What the skills module logs: skill names and counts, never a skill's text. Event ids 3100-3199, the .NET SDK's
 * (`Fadenstack.Skills.Log`); the ones that belong to MAF's provider (a tool it brought that the module leaves out, a body that
 * could not be loaded) have no use here.
 */
export const SkillsLog = Object.freeze({
  on: defineLog(SKILLS_LOG_CATEGORY, 3100, "On", "information", "Skills are on: {Count} of the person's own skills, {Bundled} bundled skills"),
  off: defineLog(SKILLS_LOG_CATEGORY, 3101, "Off", "information", "Skills are off: {Reason}"),
  skipped: defineLog(SKILLS_LOG_CATEGORY, 3102, "Skipped", "warning", "Skill {Skill} was skipped: {Reason}"),
  folderNotListed: defineLog(SKILLS_LOG_CATEGORY, 3103, "FolderNotListed", "information",
    "The person's own skills were left out: the machine policy lists sources, and in a browser a list means the bundled skills only"),
  extensionIgnored: defineLog(SKILLS_LOG_CATEGORY, 3105, "ExtensionIgnored", "warning",
    "The faden.yaml of skill {Skill} was ignored (the skill still works): {Reason}"),
  preloaded: defineLog(SKILLS_LOG_CATEGORY, 3107, "Preloaded", "debug", "Skill {Skill} was pre-loaded for the turn ({MatchedBy})"),
});
