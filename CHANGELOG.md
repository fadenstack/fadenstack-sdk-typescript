# Changelog

All notable changes to the Fadenstack TypeScript SDK (every `@fadenstack/*` package). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow [Semantic Versioning](https://semver.org/):
before 1.0, a minor version may break the API, and this file says where it does.

## [0.3.0] - Unreleased

### Added

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

### Changed

- **`find_tool` is the SDK's own** (`FIND_TOOL_NAME`): read, needing no listing in the agent's contract (one that lists it
  with a `risk` still decides its class) and no server check per call; offered while any tool on request is left to find.
  A Fadenstack gateway from 0.7.1 takes it as read and never holds it back. **Breaking (unlikely to matter):**
  `addTools` refuses an app's tool named `find_tool`, and an app's tool source that brings one has it left out.

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

- Two contexts that keep the same agent sign-in no longer sign each other out by renewing it at the same time.
- `packages/client/src/http/transport.ts` is UTF-8.

### Security

- No request follows a redirect, so a 307 or 308 can no longer send a request's body (chat text, a refresh token, a
  password, a pairing code) to another address (OWASP ASVS 5.0 V12).
