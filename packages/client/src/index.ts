export { FadenClient, type FadenClientOptions } from "./client.js";
export {
  FadenError,
  FadenApiError,
  FadenAuthenticationError,
  FadenPermissionError,
  FadenRateLimitedError,
  FadenFeatureNotAvailableError,
  FadenStreamError,
  FadenSignInRequiredError,
  isAbortError,
} from "./errors.js";
export {
  AgentTokenProvider,
  MemoryTokenStore,
  StaticTokenProvider,
  loginWithPassword,
  type AgentTokenProviderOptions,
  type PasswordLoginOptions,
  type TokenProvider,
  type TokenSet,
  type TokenStore,
} from "./auth/tokens.js";
export { FadenTransport, jsonRequest, type FetchLike, type RequestSpec, type TransportOptions } from "./http/transport.js";
export { parseError, toApiError, retryAfterMs, type ParsedError } from "./http/errorReader.js";
export { FadenChatClient, requestBody, toolCall, toFadenEvent, type ChatClientSettings } from "./chat/chatClient.js";
export { readSse, type SseEvent } from "./chat/sse.js";
export {
  eventKind,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type ChatStreamer,
  type ChatUpdate,
  type ContentPart,
  type FadenEvent,
  type FinishReason,
  type JsonSchema,
  type ReasoningEffort,
  type ToolCall,
  type ToolDefinition,
  type Usage,
  type WireToolCall,
} from "./chat/types.js";
export { readNotice, type ChatOutcome, type GovernanceNotice } from "./governance.js";
export {
  toAgentProfile,
  toWireEvent,
  type AgentClientEvent,
  type AgentProfile,
  type ApprovalDecidedEvent,
  type LocalMcpAttachedEvent,
  type ServerFeatures,
  type SessionStatsEvent,
  type ToolContractEntry,
  type ToolExecutedEvent,
} from "./models.js";
export { AgentResource, MAX_EVENTS_PER_REPORT } from "./resources/agent.js";
export {
  OPEN_WORLD_ENFORCED,
  TOOL_MODES,
  TOOL_MODE_HEADER,
  decideTool,
  effectiveToolClass,
  narrowestMode,
  parseToolClass,
  parseToolMode,
  type ToolClass,
  type ToolMode,
  type ToolModeDecision,
} from "./tools/toolModes.js";
