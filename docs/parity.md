# Parity with the .NET SDK

This page lists the features of the TypeScript SDK next to the .NET SDK's: one row per feature, the name in each, and where a browser does it differently. Both SDKs talk to the server on the same wire, keep the same transcript format and use the same event names, ids and fields in their logs, so an application behaves the same in either.

This table is for SDK 0.3.0, against Fadenstack server 0.7.1. TypeScript names are camelCase and have no `Async` suffix; durations are milliseconds where .NET has `TimeSpan`. A dash means the SDK has no such feature, and the last column says why.

## Connection and sign-in

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The client for an agent | `FadenstackClient.ForAgent(serverUrl, agent, out tokens, store)` | `FadenstackClient.forAgent({ serverUrl, agent, store })`, which returns `{ client, tokens }` | |
| Agent sign-in | `AgentTokenProvider`, `SignInAsync(loginToken, deviceLabel)` | `AgentTokenProvider`, `signIn(loginToken, deviceLabel)` | |
| Password login | A login token from your own flow | `loginWithPassword({ apiUrl, email, password })` | |
| Where the sign-in is kept | `FileTokenStore` (default; DPAPI on Windows), `MemoryTokenStore`, `ITokenStore` | `MemoryTokenStore` (default), your own `TokenStore` | No file by default: a store over `chrome.storage` in an extension, over a file in Node. |
| Sign in by pairing | `AgentPairing`: `StartAsync`, `WaitAsync`, `RedeemAsync` | `AgentPairing`: `start`, `wait`, `redeem` | |
| One pairing for several agents | `PairingStart.Agents`, `AgentsLeft`, `FadenstackPairingAgentException` | `PairingStart.agents`, `ignoredAgents`, `FadenstackPairingAgentError` | |
| The sign-in page on the server's own address | Refused otherwise, with `FadenstackException` | Refused otherwise, with `FadenstackError` | |
| A server too old for pairing (404, 405) | `FadenstackPairingUnsupportedException` | `FadenstackPairingUnsupportedError` | |
| Plain chat completions | `FadenstackClient` without an agent | `FadenstackClient` without an agent | |

## The agent

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The builder | `FadenstackAgent.CreateBuilder()`, `AgentBuilder` | `FadenstackAgent.createBuilder()`, `AgentBuilder` | |
| Registering with the host's container | `AddFadenstackAgent` | None | No container: create the agent where the application starts. See [Hosting](hosting.md). |
| Sessions, streaming a turn | `StartSessionAsync`, `OpenSessionAsync`, `StreamAsync`, `SendAsync` | `startSession`, `openSession`, `stream`, `send` | |
| Stopping a turn | A `CancellationToken` | An `AbortSignal` | |
| Attachments, pictures, skills | `MessageAttachment`, `SendOptions` | `MessageAttachment`, `SendOptions` | |
| Model rounds, history budget | `UseMaxRounds`, `UseHistoryBudget` | `useMaxRounds`, `useHistoryBudget` | |
| Reporting to the server | `UseEventReporting`, `DescribeApp` | `useEventReporting`, `describeApp` | |
| Outcomes, notices and errors | `AgentResult`, `FadenstackException` and its subclasses | `AgentResult`, `FadenstackError` and its subclasses | |

## Tools and approvals

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| Declaring a host tool | `[AgentTool(ToolClass.Read)]` on a method, `AddTools` | `defineTool({ ..., toolClass: "read" })`, `addTools` | |
| Tool classes and modes | `ToolClass`, `ToolMode` | `ToolClass`, `ToolMode` (`off`, `read_only`, `ask`, `auto`, `bypass`) | |
| The approval handler | `IApprovalHandler`, `ApprovalDecision` | `ApprovalHandler`, `ApprovalDecision` | |
| The request names its session (S-1) | `ApprovalRequest.SessionId` | `ApprovalRequest.sessionId` | |
| Allow always, per signed-in user | `IApprovalStore` | `ApprovalStore`: `IndexedDbApprovalStore`, `MemoryApprovalStore` | IndexedDB in a browser, memory in Node. |
| Grants for a time and for a stretch of work | `AgentGrants`, `GrantPlace`, `OfferWorkAsync` | `AgentGrants`, `GrantPlace`, `offerWork` | |
| Bypass and the second sign-in | `StartBypassAsync`, `IStepUpHandler`, `UsePermissionMode` | `startBypass`, `StepUpHandler`, `usePermissionMode` | `browserStepUp()` opens the page in a new tab. |
| The grant lifecycle | `GrantLifecycle` | `GrantLifecycle` | |
| Host commands | `InvokeToolAsync`, `StreamToolAsync`, `HostCommandOptions` | `invokeTool`, `streamTool`, `HostCommandOptions` | |
| Fresh policy for the model's host calls | `RequireHostToolPolicyChecks`, `CheckHostToolAsync` | `requireHostToolPolicyChecks`, `checkHostTool` | |
| The organisation's tools list | `ListToolsAsync` | `listTools` | |
| Changing tool sources | `IChangingToolSource` | `ChangingToolSource` | |
| Tools per conversation | `IToolScope` | `ToolScope` | |
| Local MCP servers, `find_tool` | `Fadenstack.Mcp`: `AddLocalMcp`, `LocalMcpModule` | `OnRequestTools` over the host's own tools | A browser cannot start a process. See [Local tools](local-tools.md). |
| SDK ids for empty or repeated call ids | `fs-{turn}-{round}-{index}` | `fs-{turn}-{round}-{index}` | |

## Stages, modules and services

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| Modules | `IFadenstackModule`, `Use` | `FadenstackModule`, `use` | |
| Required client modules | `required_client_modules` | `required_client_modules` | |
| Stages and their order | `AddChatStage`, `AddToolStage`, `IToolStage`, `StageOrder` | `addChatStage`, `addToolStage`, `ToolStage`, `StageOrder` | A chat stage wraps a `ChatStreamer`, not an `IChatClient`. |
| Tool services | `AddToolService<T>(factory)`, `GetService<T>()` | `addToolService(key, factory)`, `context.services.get(key)` | A service has a typed key (`toolServiceKey`), not a type. |
| The client's transport | `client.Transport`, `FadenstackTransport` | `client.transport`, `FadenstackTransport` | |
| Content marking | `Fadenstack.Provenance` | `@fadenstack/provenance` | |

## Sessions and a person's data

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The session store | `ISessionStore`: files per user | `SessionStore`: `IndexedDbSessionStore`, `MemorySessionStore` | IndexedDB in a browser, memory in Node. |
| Encryption of the stores | `ISecretProtector`: DPAPI or the OS key store (`FadenstackSecrets.UseOsKeyStore()`) | `SecretProtector`: a WebCrypto key, not extractable, one per user | A browser profile is not an OS account, so the protection is the browser's. See [Encryption](sessions.md#encryption). |
| Retention, with the server's `local_retention` | `SessionRetention`, `UseSessionRetention` | `SessionRetention`, `useSessionRetention`, `withinServerRetention` | |
| Export my data | `ExportMyDataAsync(stream)`: a ZIP | `exportMyData()`: a `MyDataExport` object | A page hands the object to the person as a download. |
| Delete my data | `DeleteMyDataAsync()`: `DataDeletion(FoldersRemoved, HostSessionStoreLeft, HostApprovalStoreLeft)` | `deleteMyData()`: `DataDeletion` with `storesCleared`, `hostSessionStoreLeft`, `hostApprovalStoreLeft`, `hostStoresLeft` | The SDK removes IndexedDB databases, not folders. |
| The device agent registry, OS key store package | `Fadenstack.Agents.Registry`, `Fadenstack.Secrets` | — | These belong to the operating system. |

## Thinking

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The app's effort | `UseReasoning(ReasoningEffort)`: `None`, `Low`, `Medium`, `High`, `ExtraHigh` | `useReasoning(effort)`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | `minimal` is only in TypeScript, where it is sent as set. |
| The levels a person picks | `ReasoningLevel`: Auto, Off, Low, Medium, High | `ReasoningLevel`: `auto`, `off`, `low`, `medium`, `high` | |
| The server's maximum | `ui.reasoning.max`: `minimal` caps at none, `max` sets no cap | `ui.reasoning.max`: `minimal` caps at none, `max` sets no cap | |
| The pick, kept per person and agent | `agent.ReasoningChoices`, `SetReasoningAsync`, a file in the user's folder | `agent.reasoningChoices`, `setReasoning`, `ReasoningStore` (IndexedDB) | |
| The pill | `AgentChatViewModel`: `SelectReasoningCommand` and the options | `AgentChatViewModel`: `reasoningOptions`, `selectReasoning` | |

## Chat

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The view models | `Fadenstack.UI`: `AgentChatViewModel` | `@fadenstack/ui`: `AgentChatViewModel` | |
| The skins | `Fadenstack.UI.Wpf`, `Fadenstack.UI.Avalonia` | `@fadenstack/ui-react`, `@fadenstack/ui-vue`, with `@fadenstack/ui-web` | |
| The approval broker | `ApprovalBroker` | `ApprovalBroker` | |
| The turn gate | `AgentChatOptions.TurnGate`, `IsWaitingForSlot` | `turnGate`, `isWaitingForSlot` | The gate returns a lease: a function or `{ dispose() }`. |
| Host commands in the panel | `AgentChatViewModel.InvokeToolAsync`, `BeforeCommand`, `AfterCommand` | `invokeTool`, `beforeCommand`, `afterCommand` | |
| The notice for an unmarked answer | `TellUnmarked`, preference `tell-unmarked`; off by default | `showUnmarkedNotice`, preference `unmarkedNotice`; off by default | The preference is in `localStorage`. |
| Nested Markdown, preview, Mermaid | Depth 3, preview and source, Mermaid marked | The same | Mermaid is shown as marked text, not drawn. |
| Languages | English, German, French, Spanish, Simplified Chinese | The same | |

## Logging

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The logger | `UseLogging(ILoggerFactory)` | `useLogging(FadenstackLogger)` | |
| Event ids and names | `Fadenstack.Client` 1000 to 1099, `Fadenstack.Agents` 2000 to 2099 | The same ids, names and fields | |
| Content in logs | Never | Never | |
| A log file | `FadenstackFileLoggerProvider` | — | A browser has no folder to write to: forward the events to your own logger. |
| Traces and metrics | `FadenstackTelemetry` | — | |

## Tests and samples

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| A fake server | — | `@fadenstack/testing`: `FakeGateway` | |
| The live check | `Fadenstack.Samples.LiveCheck` | `samples/livecheck.mjs` | See [Samples](samples.md). |
| Console and panel samples | `Fadenstack.Samples.Console`, `Fadenstack.Samples.Wpf` | — | |
