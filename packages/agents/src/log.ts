import { defineLog } from "@fadenstack/client";

/** The category of everything the agent logs. */
export const AGENT_LOG_CATEGORY = "Fadenstack.Agents";

/**
 * What the agent logs: names, ids, counts, durations and outcomes -- never a prompt, an answer, reasoning, attachment text,
 * tool arguments or results, a token, a secret, or who the user is. Event ids 2000-2099, the .NET SDK's
 * (`Fadenstack.Agents.Log`); the ones that belong to files on a disk (data export, adoption, transcripts kept in memory)
 * have no use in a browser and are not here.
 */
export const AgentLog = Object.freeze({
  profileLoaded: defineLog(AGENT_LOG_CATEGORY, 2000, "ProfileLoaded", "information",
    "Agent {Agent} loaded: version {Version}, edition {Edition}, {FeatureCount} features, user partition {UserPartition}"),
  toolsSettled: defineLog(AGENT_LOG_CATEGORY, 2001, "ToolsSettled", "information",
    "Agent {Agent} tools settled: {HostTools} host, {SourceTools} from sources, {Dropped} dropped by the contract"),
  toolDropped: defineLog(AGENT_LOG_CATEGORY, 2002, "ToolDropped", "warning", "Host tool {Tool} is not in the agent's contract and was dropped"),
  bypassMode: defineLog(AGENT_LOG_CATEGORY, 2003, "BypassMode", "warning",
    "Agent {Agent} is set to bypass mode, which this server does not allow: every tool call that would ask still asks; bypass mode never answers the gateway's own tools"),
  profileRereadFailed: defineLog(AGENT_LOG_CATEGORY, 2009, "ProfileRereadFailed", "warning",
    "Agent {Agent} could not read its profile again ({ErrorType}); the one held stays"),
  turnStarted: defineLog(AGENT_LOG_CATEGORY, 2010, "TurnStarted", "information",
    "Turn {TurnId} of conversation {ConversationId} started in tool mode {ToolMode} with {Attachments} attachments"),
  turnEnded: defineLog(AGENT_LOG_CATEGORY, 2011, "TurnEnded", "information",
    "Turn {TurnId} of conversation {ConversationId} ended {Status} ({Outcome}) after {Rounds} rounds in {DurationMs} ms, tool mode {ToolMode}"),
  modelRequest: defineLog(AGENT_LOG_CATEGORY, 2012, "ModelRequest", "debug",
    "Model request {Round} of turn {TurnId} answered with {ToolCalls} tool calls in {DurationMs} ms"),
  toolsRefreshed: defineLog(AGENT_LOG_CATEGORY, 2013, "ToolsRefreshed", "information",
    "Agent {Agent} asked {Sources} changed tool sources again: {Tools} tools now"),
  toolsRefreshFailed: defineLog(AGENT_LOG_CATEGORY, 2014, "ToolsRefreshFailed", "warning",
    "Agent {Agent} could not ask a changed tool source again ({ErrorType}); it keeps the tools it had"),
  toolCall: defineLog(AGENT_LOG_CATEGORY, 2020, "ToolCall", "information",
    "Tool {Tool} ({ToolClass}, {Source}) ended {Outcome} in {DurationMs} ms, approval {Approval}"),
  approval: defineLog(AGENT_LOG_CATEGORY, 2021, "Approval", "information",
    "Approval for {Tool} ({ToolClass}): {Approval}, asked {Asked}, waited {WaitMs} ms"),
  notice: defineLog(AGENT_LOG_CATEGORY, 2030, "Notice", "information",
    "Governance notice {Outcome} at stage {Stage}, category {Category}, code {Code}, decision {DecisionId}"),
});
