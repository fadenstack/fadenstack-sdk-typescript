# Parity with the .NET SDK

This page lists the features of the TypeScript SDK next to the .NET SDK's: one row per feature, the name in each, and where a browser does it differently. Both SDKs talk to the server on the same wire, keep the same transcript format and use the same event names, ids and fields in their logs, so an application behaves the same in either.

This table is for SDK 0.3.0, against Fadenstack server 0.7.1. TypeScript names are camelCase and have no `Async` suffix; durations are milliseconds where .NET has `TimeSpan`. A dash means the SDK has no such feature, and the last column says why.

## Connection and sign-in

| Feature | .NET | TypeScript | Where a browser differs |
|---|---|---|---|
| The client for an agent | `FadenstackClient.ForAgent(serverUrl, agent, out tokens, store)` | `FadenstackClient.forAgent({ serverUrl, agent, store })`, which returns `{ client, tokens }` | |
| Agent sign-in | `AgentTokenProvider`, `SignInAsync(loginToken, deviceLabel)` | `AgentTokenProvider`, `signIn(loginToken, deviceLabel)` | |
| Password login | `PasswordLogin.LoginAsync` | `loginWithPassword({ apiUrl, email, password })` | |
| Where the sign-in is kept | `FileTokenStore` (default; DPAPI on Windows), `MemoryTokenStore`, `ITokenStore` | `MemoryTokenStore` (default), your own `TokenStore` | No file by default: a store over `chrome.storage` in an extension, over a file in Node. |
| Sign in by pairing | `AgentPairing`: `StartAsync`, `WaitAsync`, `RedeemAsync` | `AgentPairing`: `start`, `wait`, `redeem` | |
| One pairing for several agents | `PairingStart.Agents`, `AgentsLeft`, `FadenstackPairingAgentException` | `PairingStart.agents`, `ignoredAgents`, `FadenstackPairingAgentError` | |
| The sign-in page on the server's own address | Refused otherwise, with `FadenstackPairingPageElsewhereException` | Refused otherwise, with `FadenstackPairingPageElsewhereError` | |
| Typed sign-in errors | `FadenstackUnreachableException`, `ServerCertificateException`, `FadenstackHttpsRequiredException` (an `ArgumentException`), `FadenstackBadCredentialsException` | `FadenstackUnreachableError`, `FadenstackHttpsRequiredError` (a `TypeError`), `FadenstackBadCredentialsError` | No certificate error: a browser does not say whether the certificate was the reason, so it is `FadenstackUnreachableError`. |
| Is it a Fadenstack server (the wizard's Checking) | `ServerCheck.CheckAsync(server, http, allowInsecureHttp, trustedCaCertificate)`, `ServerCheck.Timeout` | `checkServer({ server, fetch, signal, allowInsecureHttp })`, `SERVER_CHECK_TIMEOUT_MS` | No `trustedCaCertificate`: the platform's trust decides. |
| The connection wizard's view model (F15, I15) | `Fadenstack.UI.Wizard.ConnectionWizardViewModel` (commands as `RelayCommand`s), `WizardOptions`, `IConnectionStore`, `IEndpointKeyStore`, `IWizardStep`, `IServerSignIn`, `IEndpointChecker`, `IWizardClock`, `ServerSignIn`, `EndpointChecker`, `SystemWizardClock` | `ConnectionWizardViewModel` (commands as methods, availability in `can`, change events through `subscribe`/`onCompleted`), `WizardOptions`, `ConnectionStore`, `EndpointKeyStore`, `WizardStepHandler`, `ServerSignIn`, `EndpointChecker`, `WizardClock`, `createServerSignIn`, `createEndpointChecker`, `createSystemClock`; enums are frozen consts (`WizardStep`, ...) in camelCase strings; the texts: `services.strings` (`UiStrings`, English by default) with `strings`, `addressErrorText`, `startFailureText`, `passwordFailureText`, `problemText`, `waitingText`, `signedInText`, `resultLines`, `connectedText` | No UI thread, so no dispatcher. **The wizard's 137 texts** (`wizard…` in `UiStrings`) are the .NET texts in five languages, copied from the resx; the four enum-keyed ones are records keyed by the TS enums' values, and the countdown takes milliseconds (`wizardWaiting(leftMs)`, `m:ss`). `EndpointChecker.placeOf` answers at once (no name resolution) and there is no local search (`findLocal` finds nothing). **The app's step before an endpoint check runs inside the user gesture** (Chrome's `chrome.permissions.request`): before the command's first `await`, except after saving a key. **A pairing survives a closed side panel**: `WizardOptions.pairingKeeper` (`keep`, `restore`, `forget`; `chrome.storage.session`) with `AgentPairing.export` and `resume`; .NET has no such thing. **The views**: `ConnectionWizard` in `@fadenstack/ui-react` (the Chrome agent) and in `@fadenstack/ui-vue` (kept at parity, not used in 0.3.0), one narrow column with one view per `WizardStep`; a password or a key is read from an uncontrolled input when its button runs and cleared at once, and the app's steps are drawn through `renderAppStep` (React) or the `app-step` slot (Vue). |
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
| The SDK's own tool names (`find_tool`, `load_skill`, `read_skill_resource`, `run_skill_script`, `web_search`) | `AgentTool.ReservedNames`; `AddTool`/`AddTools` refuse them (`ArgumentException`); a local MCP server's are left out | `RESERVED_TOOL_NAMES`; `addTools` and `OnRequestTools` refuse them (`TypeError`) | |
| A tool source's tool whose name is taken | Left out (the app's tool wins, then the first source), logged (event 2017) | The same (event 2017) | |
| Open-world calls ask below Auto | `ToolModes.Decide(mode, class, openWorld)`, `ToolModes.ConversationOnly`, `OpenWorldEnforced` true | `decideTool(mode, class, approval, openWorld)`, `conversationOnly`, `OPEN_WORLD_ENFORCED` true | |
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
| The machine policy | `MachinePolicy.Load(path)`, `FromJson`, `From(JsonElement)`; `UseMachinePolicy(policy)`; `MachinePolicyException` | `MachinePolicy.from(object)`, `fromJson`; `useMachinePolicy(policy)`; `MachinePolicyError` | A browser has no policy file, so no `Load`: an extension hands `chrome.storage.managed`'s object to `from`. `fromJson` is strict JSON (no comments or trailing commas). |
| Endpoint watermarks (no server) | `FadenstackChatOptions.Unread` (`faden.unread`), `EndpointDialect.WatermarkSwitchOff`, `FadenstackAgent.EndpointWatermark`, `EndpointCheck.WatermarkOf`/`ServerOf` | `ChatOptions.unread`, `EndpointDialect.watermarkSwitchOff`, `agent.endpointWatermark`, `EndpointCheck.watermarkOf`/`serverOf` | `unread` is a plain option: TypeScript has no `AdditionalProperties` bag. |
| Where an endpoint points | `EndpointCheck.PlaceOfAsync(baseUrl)` (resolves the name), `EndpointPlace` | `EndpointCheck.placeOf(url)`, `EndpointPlace` | Synchronous, by the host's spelling: a browser cannot resolve names. The check also uses the first listed model when the endpoint names none, as .NET. |
| Records signed on the device (no server) | `LocalProvenanceBackend`, `DeviceSigner`, `UseLocalBackend`: the key in the OS key store, the log a rotating file, DigiCert by default | `LocalProvenanceBackend`, `DeviceSigner`, `localBackend`: a non-extractable WebCrypto key, the log and the kept records in IndexedDB per principal, DigiCert by default with the token check in WebCrypto and DigiCert's root embedded | A browser has no key store, files or certificate store, and `fetch` cannot reach an http-only authority from an https page (the records wait in the queue). The log keeps a number of entries, not bytes. |
| Skills on the device | `Fadenstack.Skills`: `SkillsModule`, `SkillsOptions` (folders, bundled skills), `ILocalSkillsPolicy`; Microsoft Agent Framework's `AgentSkillsProvider` reads the folders and answers `load_skill` and `read_skill_resource` | `@fadenstack/skills`: `skillsModule`, `SkillsOptions` (bundled skills, a store), `LocalSkillsPolicy`; the SDK's own loader answers the two tools (the same names, arguments, answers and `Error: ...` texts); the person's own skills in IndexedDB per principal (`SkillStore`, database `fadenstack-skills`) | There is no Microsoft Agent Framework in TypeScript, and no folder in a browser: skills are records, import and export go through zip (later). A machine policy that lists sources keeps only the bundled skills. The `faden.yaml` reader, `SkillExtension` and the resolver are ported one to one (same limits and numbers); a keyword is matched with a Unicode-aware whole-word expression, without .NET's regular-expression timeout (a keyword is escaped text). |

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
