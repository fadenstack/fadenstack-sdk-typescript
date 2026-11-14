# Changelog

All notable changes to the Fadenstack TypeScript SDK (every `@fadenstack/*` package). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow [Semantic Versioning](https://semver.org/):
before 1.0, a minor version may break the API, and this file says where it does.

## [0.3.0] - Unreleased

### Added

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
