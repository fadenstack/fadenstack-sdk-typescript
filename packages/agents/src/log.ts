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
  toolNameReserved: defineLog(AGENT_LOG_CATEGORY, 2016, "ToolNameReserved", "warning",
    "A tool source's tool {Tool} was left out: the name is the SDK's own"),
  toolNameTaken: defineLog(AGENT_LOG_CATEGORY, 2017, "ToolNameTaken", "warning",
    "A tool source's tool {Tool} was left out: {Winner} has that name"),
  toolCall: defineLog(AGENT_LOG_CATEGORY, 2020, "ToolCall", "information",
    "Tool {Tool} ({ToolClass}, {Source}) ended {Outcome} in {DurationMs} ms, approval {Approval}"),
  approval: defineLog(AGENT_LOG_CATEGORY, 2021, "Approval", "information",
    "Approval for {Tool} ({ToolClass}): {Approval}, asked {Asked}, waited {WaitMs} ms"),
  notice: defineLog(AGENT_LOG_CATEGORY, 2030, "Notice", "information",
    "Governance notice {Outcome} at stage {Stage}, category {Category}, code {Code}, decision {DecisionId}"),
  approvalAnswerRetried: defineLog(AGENT_LOG_CATEGORY, 2053, "ApprovalAnswerRetried", "warning",
    "An approval answer got no word back ({Kind}); it is sent once more"),
  /** sdk/51 F10 (owner, 14 Nov): `build()` says once that a standalone agent goes without the provenance module. */
  noProvenanceModule: defineLog(AGENT_LOG_CATEGORY, 2054, "NoProvenanceModule", "warning",
    "Agent {Agent} runs on its own model endpoint without the provenance module: what it places in documents carries no mark. Add @fadenstack/provenance (builder.use(provenanceModule()))"),
  /** sdk/51 F07: an app's hook threw; it counts as "go on". The hook's name and the error's type, never the message. */
  hookFailed: defineLog(AGENT_LOG_CATEGORY, 2060, "HookFailed", "warning", "A hook ({HookType}) threw {ErrorType}; the call goes on as the policy decided"),

  // web_search (sdk/51 F06): the provider, a count, a duration and the kind of failure; never the query, a result or the key.
  webSearchRan: defineLog(AGENT_LOG_CATEGORY, 2080, "WebSearchRan", "information", "A web search with {Provider} found {Count} results in {DurationMs} ms"),
  webSearchFailed: defineLog(AGENT_LOG_CATEGORY, 2081, "WebSearchFailed", "warning", "A web search with {Provider} failed ({Kind})"),
  webSearchOff: defineLog(AGENT_LOG_CATEGORY, 2082, "WebSearchOff", "debug", "Web search is not offered ({Reason})"),
});
