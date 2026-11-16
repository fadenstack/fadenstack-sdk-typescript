# Changelog

All notable changes to the Fadenstack TypeScript SDK (every `@fadenstack/*` package). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow [Semantic Versioning](https://semver.org/):
before 1.0, a minor version may break the API, and this file says where it does.

## [0.3.0] - Unreleased

### Added

- **The mark on copy** ([Marking AI-generated content: Copying an answer](docs/provenance.md#copying-an-answer), AI Act Art. 50(2)).
  `agent.markCopy({ text, html?, chat?, turn?, code?, file? })` marks what the person copies out of the chat through the
  provenance module's pipeline (the tool `copy`, the sink `clipboard` that carries `html-attribute`, the receipt of the turn):
  the HTML carries the mark, the plain text stays as it is, code and exempt content is recorded as exempt, and with the policy
  `refuse` a copy that cannot be marked is not made (`refused`; the chat says so in five languages). The chat's Copy, a copied
  table and a code block's Copy use it, and a chat saved as Markdown (`saveChatMarkdown`) is marked in its front matter (the sink
  `file`). An app with its own view of answers calls `markCopy` itself. `AnswerCopyMarker` and `AgentBuilder.useAnswerCopyMarker`
  are the seam (the provenance module sets it). Under each answer `turn.copyStatus` says "Copied" or why nothing was copied, in
  the React and Vue skins. Behaviour change: `turn.copy()`, `part.copyTable` and `part.copyCode` return a promise (a `CopyResult`).
- **Stop everything and the off-switch** ([Stop everything and the off-switch](docs/stop-everything.md)). `agent.stopAll()` (and
  `FadenstackAgent.stopAll(agents)`) stops every running turn in every open chat, answers a waiting card no, and ends every grant of the
  agent (the server's and the chats' "for this chat" approvals; "always" stays), also offline, and returns a `StopAllResult`. `chat.stop()`
  stops one chat's turn. `StopEverythingViewModel` and a `StopEverythingButton` in the React and Vue skins are the control for a toolbar,
  with no confirmation. A refresh the server refused ends a running turn at once; no tool call of it runs after. For core 0.7.1's
  off-switch: `ErrorCodes.agentDisabled`, `isAgentDisabled`, `AgentProfile.enabled`, `agent.turnedOff` with `onTurnedOffChange` and
  `checkAgain()`, and the outcome `"agent_disabled"`: an agent that is off stops its turns and ends its grants, refuses a new turn without
  a request, and makes no request but its events and manifest. The chat panel shows "Your organisation turned this agent off." with "Check
  again" and a disabled composer. `FakeGateway` has `turnOff()` and `turnOn()`.
- **What the app reports about the device** ([Tools and approvals: What your app reports about the device](docs/tools.md#what-your-app-reports-about-the-device)). The manifest the agent sends at start carries a `device` block: a short `os` (the browser's platform, or Node's type, release and architecture; never the whole user agent), the app's `app_version` and the plugins the app declares with the new `describePlugins(plugins)` (name, version and SHA-256 of each). Cut to the server's limits (`DEVICE_LIMITS`); an entry that does not fit is left out and logged (event 2018) by kind and reason. `mcp_programs` is always empty in a browser. `FakeGateway` checks the block as core 0.7.1 does and `deviceOf(agent)` returns it.
- **Content logging is off until the person switches it on for a time** ([Interop: Content logging](docs/interop.md#content-logging), 8.1).
  `agent.contentLogging` (`isOn`, `until`, `offered`, `canStart`, `onChanged`), `startContentLogging(ms)` (15 minutes to 24 hours)
  and `stopContentLogging()`; `ContentLoggingError` when the app did not offer it or the policy forbids it; the machine policy key
  `contentLogging` (`MachinePolicy.contentLogging`). It ends by itself, is not kept across restarts, and each start and stop is
  logged without content (event ids 2083, 2084).
  - `ContentLoggingSettingsViewModel` with `ContentLoggingSettings` (React and Vue), and the band in the chat
    (`chat.contentLogging`, `ContentLoggingBand`, "Content logging is on until 14:30. ...", Stop); texts in five languages.
- **Your data per app** ([Data on the device: Export and delete](docs/data-on-device.md#export-and-delete)). `deleteMyData` and
  `exportMyData` take `{ scope: "thisApp" | "allApps" }`: `thisApp` (the default) covers the calling app's chats, "Allow always" and
  thinking levels, and the person's shared data (skills, the MCP list, keys, provenance records, other settings, the data key) only
  when no other Fadenstack app in this browser uses it; `allApps` covers everything. `DataDeletion` gains `scope`, `otherApps`,
  `sharedDataKept` and `agentsKept`; `MyDataExport` gains `scope`, `app`, `otherApps` and `agentsKept`. `myDataApps()` lists the apps
  that use the person's data; each agent start records its app in the person's `fadenstack-apps` database (names and times, no
  content). **Behaviour change:** `deleteMyData()` and `exportMyData()` without a scope used to cover every app; pass
  `{ scope: "allApps" }` for that (an `AbortSignal` alone still works and means `thisApp`).
  - `MyDataSettingsViewModel` in `@fadenstack/ui`, with `MyDataSettings` in `@fadenstack/ui-react` and `@fadenstack/ui-vue`: the "Your
    data in this browser" control (export, remove, each removal asked first with what stays and why, a result line); 34 `myData…`
    texts in five languages, which say "in this browser" where the .NET SDK says "on this device".
- **Old chats are a setting** ([Sessions: Retention](docs/sessions.md#retention)). In standalone mode the person chooses whether old
  chats are deleted automatically, and the limits (days 1 to 3650, chats 1 to 10000; defaults on, 90 days, 50 chats, or the app's
  `useSessionRetention`); off keeps every chat until the person deletes it. In governed mode the server decides as before (the
  stricter of the app's limits and `local_retention`) and the person has no setting.
  - `FadenstackAgent.chatRetention` (`ChatRetentionState`: `control`, `autoDelete`, `maxAgeDays`, `maxSessions`, `canChange`),
    `setChatRetention(choice)`; the choice is kept per person in the `retention` store of `fadenstack-preferences` (that database
    is now version 2).
  - The machine policy may fix it: `chatRetention` (`MachinePolicy.chatRetention`); see [Machine policy](docs/machine-policy.md).
  - Pruning also runs when the agent starts and when the person turns it on or lowers a limit, never on a chat that is open;
    `IndexedDbSessionStore.prune`, `setRetention(undefined)` for off.
  - `ChatRetentionSettingsViewModel` in `@fadenstack/ui`, with `ChatRetentionSettings` in `@fadenstack/ui-react` and
    `@fadenstack/ui-vue`; 17 `chatRetention…` texts in five languages.

- **The export holds all the deletion removes, the `localStorage` helpers are per person, the skills module knows its person** (Found writing Data on the device): `exportMyData()` adds optional `databases` (preferences, skills and switches, provenance records and log, MCP servers without header values and with a clean address, the MCP audit log; read by an allowlist, never a key) and `localStorage`; `format` and `version` stay 1. `browserPreferences()` and `browserPromptStore()` keep `fadenstack.<name>:<tenant>:<user>` (`userLocalKey`), follow the agent's principal through the chat, and `deleteMyData()` removes the person's keys (counted in `storesCleared`); the standalone principal adopts the old shared key once. `skillsModule`'s default store and switches list nothing and refuse a change (`SkillsPersonUnknownError`) until the agent has read the profile that names the person. `@fadenstack/ui-web` now depends on `@fadenstack/agents`.
- **`@fadenstack/mcp`: local MCP servers over HTTP** (sdk/51 F05): `mcpModule({ store, servers, trustedServers })` attaches the person's HTTP MCP servers and the app's own, lists their tools as host tools (`source: "mcp"`, `server`: the label; held back behind `find_tool`; a name the SDK keeps is left out, the first server's tool of a name wins, both logged) and calls them (results fenced as untrusted data, hidden characters removed, long ones cut). The client is `@modelcontextprotocol/client` 2.4.0, pinned, main entry only, with `versionNegotiation: { mode: 'auto' }`: MCP 2026-07-28 first, 2025-11-25 as the fallback; `McpServerStatus.protocolVersion` says which. The hint rule (H4): a tool arrives unclassified; `destructiveHint: true` from any server makes it destructive (a floor); a `readOnlyHint` counts only from a server the person (standalone) or the administrator (governed) marked trusted; only they raise a tool to read or write (`toolClassFor`). Policy: governed follows the profile's `local_mcp.mode`, standalone the person's setting under the machine policy's `mcp` (forbidden, or the listed labels). The person's servers are in IndexedDB per principal (`fadenstack-mcp`), their header values sealed with the principal's WebCrypto key and removed by `deleteMyData`; `parseMcpConfig` and `McpModule.importConfig` read a pasted `mcpServers` or VS Code `servers` configuration, and everything arrives off and not reviewed (a program is listed as not possible in a browser). Typed errors: `McpConnectError`, `McpConfigError`, `McpPolicyError`, `McpStoreError`. `@fadenstack/agents` exports `browserSecretProtector` and `recordContext`, and `userDatabaseNames` names the new database. HTTP only: no stdio servers and no scan (see [parity](docs/parity.md)).
- **The skill editor's views** (sdk/51 F04): `SkillLibrary`, `SkillEditor` and `SkillDraft` in `@fadenstack/ui-react` (the Chrome agent's skin) and in `@fadenstack/ui-vue` (parity), in the wizard's column: the list with its source and "not reviewed" labels and switches, the editor with its checks as you type, a Markdown preview, the `faden.yaml` fields, the files and the Try panel, and the draft's plain statement that nothing is saved until Save; import is a zip file input and export a download (`browserSkillFiles()` in `@fadenstack/ui-web`, which also gains the `fdn-skills…` styles).
- **The skill editor's view models, store, checks, import and export** (sdk/51 F04, the third slice): `SkillLibraryViewModel`, `SkillEditorViewModel` and `SkillDraftViewModel` in `@fadenstack/ui` (headless, `Observable`); the contracts (`SkillWorkshop`, `SkillDocument`, `SkillIssueCode`, `SkillLimits`) and the strict SKILL.md reader and writer in `@fadenstack/agents`, so the UI package never imports a module; `StoreSkillWorkshop` (`skillsModule(...).workshop()`), the validator, the on/off switches (`SkillSwitches`, kept in the person's IndexedDB and honoured by the module) and zip import and export in `@fadenstack/skills`. The zip reader and writer are the SDK's own (stored and deflate through `DecompressionStream`, no dependency) with .NET's guards: traversal, absolute paths, backslashes, links, 1 MiB a file, 5 MiB in all, 100 files, 6 MiB compressed, the 100:1 bomb ratio. Nothing is written before every check passes and the person pressed Save or Import; an existing skill is replaced only after they confirm. 117 texts in five languages (`skill...`, one per check). A resource that is not text is refused (`BinaryFile`), as a skill is text in a browser's database.
- **`@fadenstack/skills`: Agent Skills on the device** (sdk/51 F04, the skills module and the `faden.yaml` pre-selection): `skillsModule({ bundled, store })` gives the agent `load_skill` and `read_skill_resource` (class `read`, no approval; `run_skill_script` is never offered and no script runs) and tells the model the skills it has, with its own loader where .NET runs Microsoft Agent Framework's `AgentSkillsProvider`. Bundled skills are in memory; the person's own are kept in IndexedDB per principal (`SkillStore`, `IndexedDbSkillStore`, `MemorySkillStore`; database `fadenstack-skills`, standalone as its own principal). A skill keeps the six standard SKILL.md fields (name and form, description up to 1,024, compatibility up to 500); one that breaks the rule is skipped and logged, the others stay. With a server local skills are on only when the profile's `local_skills.mode` is `allow` or `developer_mode` is true; standalone they are on unless the person or the machine policy turned them off (a machine policy that lists sources keeps only the bundled skills in a browser). A `faden.yaml` (32 KiB, 8 levels, no anchors, aliases or tags) filters, ranks and pre-loads by core's rules: the list, an `ACTIVE SKILL` block marked as information, the preferred tools as a hint; a skill named with `$slug` is pre-loaded even without one. Skill text never changes a tool's class, a mode or a grant. `@fadenstack/agents` exports `CORE_TOOL_SOURCE`, which the SDK's own packages mark their tool sources with to bring the reserved names; `@fadenstack/testing`'s `FakeAgent` gets `localSkills`.
- **The connection wizard's views** (sdk/51 F15): `ConnectionWizard` in `@fadenstack/ui-react` (the Chrome agent's skin) and in `@fadenstack/ui-vue` (parity), one view per `WizardStep` in a narrow column; the password and the key are read from an uncontrolled input and cleared at once, the app's step runs inside the click, and `@fadenstack/ui-web`'s styles gain the `fdn-wizard…` classes.
- **The connection wizard's texts in five languages** (sdk/51 F15, I15 step 3): 137 `wizard…` texts in `UiStrings` (English, German, French, Spanish, Simplified Chinese), copied from the .NET SDK's texts, and `ConnectionWizardViewModel` gets `services.strings` with the computed texts `addressErrorText`, `startFailureText`, `passwordFailureText`, `problemText`, `waitingText`, `signedInText`, `resultLines` and `connectedText`.
- **Typed sign-in errors and `checkServer`** (sdk/51 I15 §2, §4): `FadenstackPairingPageElsewhereError` (the server named a sign-in
  page on another address than its own), `FadenstackHttpsRequiredError` (plain http where https is required; a `TypeError`
  still, so existing catches keep working) and `FadenstackBadCredentialsError` (`LOGIN_BAD_CREDENTIALS`; a
  `FadenstackApiError`), thrown where the plain errors were. `checkServer({ server })` asks `/api/health` within
  `SERVER_CHECK_TIMEOUT_MS` (15 s): `not_fadenstack` for an answer that is not a JSON object, `redirect` for a redirect,
  `FadenstackUnreachableError` for no answer. There is no certificate error: a browser does not say.
- **The endpoint check names a model, and `EndpointCheck.placeOf`** (sdk/51 I15 §2, §3): an endpoint without a model is checked
  with the first model `/models` lists, and the report names it. `EndpointCheck.placeOf(url)` says `EndpointPlace.ThisComputer`,
  `LocalNetwork` or `Internet` by the host's spelling (a browser cannot resolve names, as .NET's `PlaceOfAsync` does).
- **`MachinePolicy`** ([Machine policy](docs/machine-policy.md)): one vocabulary for managed installs (`server`, `standalone`,
  `endpoints`, `plainHttp`, `mcp`, `skills`, `webSearch`, `timestamping`), read fail-closed (`MachinePolicy.from(object)`,
  `fromJson`; a Chrome extension hands it `chrome.storage.managed`), enforced by `AgentBuilder.useMachinePolicy`
  (`MachinePolicyError`, `EndpointPlainHttpRefusedError` reason `forbiddenByPolicy`), narrowing local MCP and skills with a
  server too; `agent.machinePolicy`; `timestamping` is `on` (DigiCert), `off` or the organisation's own server
  (`TimestampingPolicy`, `TimestampingMode`).
- **A key over plain http only to this computer** (owner, 14 Nov): `useEndpoint` sends a key over `http:` only to a host
  written `localhost`, `127.0.0.1` or `[::1]` (a browser cannot resolve names), never to the local network; a machine
  policy's `plainHttp: forbidden` forbids it too, and the check reports `KeyUnencryptedOnThisComputer`. A standalone
  agent built without the provenance module logs one warning (event 2054); the module is never loaded on its own.
- **Endpoint watermarks** (a standalone agent): the person's endpoint's text watermark is never switched off for text people
  read. `ChatOptions.unread` marks a call whose answer no person reads, and only then does a dialect with a switch send it
  (`EndpointDialect.watermarkSwitchOff`: vLLM, SGLang); each answer's transcript entry records `endpoint_marking`;
  `agent.endpointWatermark`, `EndpointCheck.watermarkOf` and `EndpointCheck.serverOf`; the provenance module's
  watermark layer relies on the endpoint (`endpoint-<server>`) and never claims more.
- **Records signed on the device** (@fadenstack/provenance): for an agent without a server the module chooses
  LocalProvenanceBackend: the server's record format (a compact ES256 JWS with kid device:<16 hex> and a self-signed
  certificate in x5c, hash_key_version 0), signed by a non-extractable WebCrypto key kept per principal in IndexedDB
  (DeviceSigner, DeviceSigner.verify), an RFC 3161 time-stamp from DigiCert by default whose token counts only when its CMS
  signature, a time-stamping certificate that chains to DigiCert's embedded root (or `timestampRoots`) and the nonce check
  out (`Rfc3161.grants`, now async), a local backup (every record kept with its token, `keptRecords()`; offline the
  labelled device clock and a queue that survives a restart, `flushTimestampQueue()`), and a placement log in IndexedDB
  that keeps the newest entries. provenanceModule({ localBackend }) sets it up;
  deleteMyData() removes its database.
- `AgentTokenProviderOptions.locks` (`LockManagerLike`, `navigator.locks` by default where there is one): contexts that
  share a token store (an extension's side panel and its service worker, several tabs) renew a sign-in one at a time.
- `TransportOptions.streamIdleTimeoutMs` and `FadenstackClientOptions.streamIdleTimeoutMs` (5 minutes): a streamed
  answer that sends nothing at all for that long is given up with a `FadenstackError`.
- `PairingStart.agentsLeft`: the agents asked for whose tokens this device has not collected yet.
- `@fadenstack/provenance` owns the words its marks show: `MarkStrings`, `builtInMarkStrings` and `markStringsFor` in
  English, German, French, Spanish and Simplified Chinese.
- `@fadenstack/ui-web`: `browserChatServices()`, the browser's four services for a chat view model in one object, and
  `browserOpenLink` (a new tab, `noopener,noreferrer`).
- `@fadenstack/ui`: `ChatHostServices` (the four services a host passes), and `storedPromptStore` with
  `KeyedTextStorage`, the prompt store's rules over any synchronous key-value storage.
- **The connection wizard's view model** (`@fadenstack/ui`, sdk/51 F15, I15): `ConnectionWizardViewModel`, one state machine
  for "Connect to my organisation" (the address rule, the server check, pairing with one approval for all of the app's
  agents, the password fallback) and "Use my own AI" (the acceptance and its record, presets and a typed address, plain http
  to the local network only after confirming and never with a key, the key straight into the key store, the check, the
  model), and for Settings > Connection; the same steps, transitions and commands as .NET's, as methods with a `can` flag
  each. The app gives a `ConnectionStore`, an `EndpointKeyStore`, its own `WizardStepHandler`s and its `WizardOptions`; the
  machine policy shapes the choices. `createServerSignIn`, `createEndpointChecker` and `createSystemClock` drive the SDK
  (`AgentPairing`, `loginWithPassword`, `checkServer`, `EndpointCheck`). The wizard names its enums as frozen consts
  (`WizardStep`, `WizardEntry`, `WizardOutcome`, `WizardPoint`, `ConnectionMode`, `AgentAccess`, `AddressProblem`,
  `StartFailure`, `PasswordFailure`). Two things are TypeScript's own: the app's step before an endpoint check (Chrome's host
  permission) runs inside the user gesture, before the command's first `await` where it can, and a pairing survives a
  closed side panel (`WizardOptions.pairingKeeper`: kept when the code shows, forgotten when the wait ends or is cancelled,
  resumed at the code on start while it has not expired). `placeOf` answers at once and there is no local search (a browser
  cannot resolve names or scan ports).
- **`AgentPairing.export` and `resume`** (`@fadenstack/client`): a pairing written out with its pairing code
  (`PairingExport`, a secret for session storage only, never a log or a file) and made again, so the wait for an approval
  can go on in a side panel that was closed and opened again. The saved pages must be on the server's own origin.

### Changed

- **Behaviour change:** `useHookContent()` now only means that the app *offers* content logging. The model hooks see message and
  answer text only while the person has switched content logging on (`startContentLogging`). A development setup calls
  `startContentLogging` itself.
- **`find_tool` is the SDK's own** (`FIND_TOOL_NAME`): read, needing no listing in the agent's contract (one that lists it
  with a `risk` still decides its class) and no server check per call; offered while any tool on request is left to find.
  A Fadenstack gateway from 0.7.1 takes it as read and never holds it back. **Breaking (unlikely to matter):**
  `addTools` refuses an app's tool named `find_tool`, and an app's tool source that brings one has it left out.
- **Breaking:** four more tool names are the SDK's own, for its coming tools: `load_skill`, `read_skill_resource`,
  `run_skill_script` (never offered) and `web_search`; all five are in `RESERVED_TOOL_NAMES`. `addTools`, a module's
  `configure`, and `OnRequestTools` (constructor and `set`) refuse an app's tool of one of these names with a
  `TypeError` (`OnRequestTools` used to drop a `find_tool` silently); rename it. An app's tool source that brings one has
  it left out, now logged (event 2016). A Fadenstack gateway gives these names the class of the SDK's tool, so an app's
  tool under one would be taken for it.
- A tool source's tool that loses its name to the app's own tool or to an earlier source is still left out, and is now
  logged with what won (event 2017).
- **Open-world calls ask below auto** (`OPEN_WORLD_ENFORCED` is now true). In `read_only` and `ask`, a call to a tool
  marked `openWorld` (or one the gateway marks `openWorld`) asks, a read one too; `auto` and `bypass` run it. Its card
  offers Allow for this chat at most: Allow always and time grants are not offered below `auto`, and an "always"
  saved before no longer answers it. `decideTool` takes the mark as a fourth argument; `conversationOnly` says when
  the rule applies. What such a tool is given leaves the organisation, and injected text can put private data into it.
  `@fadenstack/testing`: a `gatewayTool`'s `approval` can carry `openWorld`.

- **Breaking:** `AgentSession` (`@fadenstack/agents`) is now `ChatSession`, as in the .NET SDK, where the agent becomes
  a Microsoft Agent Framework `AIAgent` with an `AgentSession` of its own; only the name changes.
- **Breaking:** the SDK follows no redirects (`redirect: "manual"`). A 3xx answer, or a browser's opaque redirect, is a
  `FadenstackApiError` with the code `redirect`.
- **Breaking:** `@fadenstack/provenance` no longer depends on `@fadenstack/ui`, and a chat's `UiStrings` no longer serve
  as mark texts: pass `markStringsFor(...)` (or your own `MarkStrings`) as the module's `strings`.
- `AgentPairing.wait`: `invalid_grant` for an agent other than the first is a `FadenstackPairingAgentError` for that
  agent (it was "expired"); for the first agent of a pairing for several, a refusal is reported so too, and the first
  approved other agent is signed in on the way.

- **Breaking:** `AgentChatViewModel` has no browser default any more (`@fadenstack/ui` uses no browser API). Its
  options are required, and with them four services the host passes: `clipboard`, `openLink`, `saveFile` and
  `preferences` (`ChatHostServices`). A forgotten one is a type error, where before the browser's took its place
  unseen; outside a browser that lost the user's choices. In a web page, spread the browser's and override what your
  host does its own way:
  `new AgentChatViewModel(agent, approvals, { ...browserChatServices(), openLink: myOpener, prompts: browserPromptStore() })`.
  A host that passed some of the four and relied on the defaults for the rest now spreads `browserChatServices()` first.
  `prompts` stays optional: without a store the feature is absent, as before.

### Removed

- **Breaking:** `UiStrings.aiGenerated` and `UiStrings.aiGeneratedTitle` (now in `@fadenstack/provenance`).
- **Breaking:** `browserClipboard`, `browserSaveFile`, `browserPreferences` and `browserPromptStore` are no longer in
  `@fadenstack/ui`: they moved, unchanged, to `@fadenstack/ui-web`.

### Fixed

- **An approval answer lost on the way is sent once more.** Answering a call the gateway holds now waits 10 seconds for a
  word back, then sends the same answer once more when none came (no answer, the server unreachable, a proxy's 502, 503 or
  504). A Fadenstack gateway from 0.7.1 (`approvals.idempotent`) takes a repeated answer once; an older one answers the
  repeat of a taken answer 404, which now counts as taken. A 409 is never sent again. Before, a lost decline left the call
  waiting until the gateway's own timeout (5 minutes). Log event 2053 (`ApprovalAnswerRetried`).
- **A chat no longer loses its own grant to another chat's refresh.** The device's copy of grants took the server's list
  (or a stream's `faden.grants`) as it was when it was asked for; a grant made meanwhile in another chat, a Bypass
  started in parallel, was dropped from the copy, so that chat ran without it and its `stopBypass` could not end it at
  the server. The copy now keeps what the server answered this device after the list or snapshot was asked for.
- Two contexts that keep the same agent sign-in no longer sign each other out by renewing it at the same time.
- `packages/client/src/http/transport.ts` is UTF-8.

### Security

- No request follows a redirect, so a 307 or 308 can no longer send a request's body (chat text, a refresh token, a
  password, a pairing code) to another address (OWASP ASVS 5.0 V12).
