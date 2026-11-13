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

### Changed

- **Breaking:** the SDK follows no redirects (`redirect: "manual"`). A 3xx answer, or a browser's opaque redirect, is a
  `FadenstackApiError` with the code `redirect`.
- **Breaking:** `@fadenstack/provenance` no longer depends on `@fadenstack/ui`, and a chat's `UiStrings` no longer serve
  as mark texts: pass `markStringsFor(...)` (or your own `MarkStrings`) as the module's `strings`.
- `AgentPairing.wait`: `invalid_grant` for an agent other than the first is a `FadenstackPairingAgentError` for that
  agent (it was "expired"); for the first agent of a pairing for several, a refusal is reported so too, and the first
  approved other agent is signed in on the way.

### Removed

- **Breaking:** `UiStrings.aiGenerated` and `UiStrings.aiGeneratedTitle` (now in `@fadenstack/provenance`).

### Fixed

- Two contexts that keep the same agent sign-in no longer sign each other out by renewing it at the same time.
- `packages/client/src/http/transport.ts` is UTF-8.

### Security

- No request follows a redirect, so a 307 or 308 can no longer send a request's body (chat text, a refresh token, a
  password, a pairing code) to another address (OWASP ASVS 5.0 V12).
