# Hosting

This page covers where an application runs the SDK, a web page, a browser extension or Node, and what differs between them. The .NET SDK's page of this name covers registering an agent with the standard host and its service container; the TypeScript SDK has no container, so this page covers the places the code runs instead.

The packages are ES modules and use standard web APIs only: `fetch`, Web Streams, Web Crypto and `AbortSignal`, plus IndexedDB in a browser. They run in Chrome 116 or later and in Node.js 24 or later.

## What is the same everywhere

- You build the agent the same way: a `FadenstackClient`, a builder, tools, an approval handler. See [Build an agent](agent.md).
- The client never sends the browser's cookies, so another sign-in in the same browser never acts in place of your application's.
- The client refuses an `http://` address unless you set `allowInsecureHttp`.
- Event reporting, the policy checks and the transcript format are the same.

## What differs

| | Web page | Browser extension | Node |
|---|---|---|---|
| Sessions and "Allow always" | IndexedDB, encrypted with a non-extractable key per signed-in user | The same, in the extension's pages and service worker | Memory only: nothing is written, no key is made |
| The sign-in | Memory by default; pass a `TokenStore` to keep it | Memory by default; a store over `chrome.storage` keeps it (see [In a browser extension](agent.md#in-a-browser-extension)) | Memory by default; a store over a file only the user can read keeps it |
| Preferences (language, the unmarked notice) | Yours to pass; `browserPreferences()` keeps them in `localStorage`, as `fadenstack.<name>` | Yours to pass: `chrome.storage`, or `browserPreferences()` (`localStorage` where there is one, else memory) | Yours to pass; `MemoryPreferenceStore` keeps them in memory |
| Opening the second sign-in or the pairing page | `openInBrowser`: a new tab, never an iframe | Give your own handler (a tab of the extension) | Give your own handler |
| The chat panel | `@fadenstack/ui-react` or `ui-vue` | The same, in a page of the extension | Not applicable: the skins draw DOM |
| Logging | Your logger, or `consoleLogger` | The same | The same |

### A web page

Create the client with `FadenstackClient.forAgent`, build the agent, and put the panel in the page. The default stores are
the signed-in user's own IndexedDB databases, so two people in one browser profile never see each other's chats. Script
that runs in your origin can ask the SDK for the sessions; see [Sessions on the device](sessions.md#indexeddb-in-a-browser)
for what that protects. The default token store keeps the sign-in in memory, so the person signs in again on the next
load; pass a `TokenStore` to keep it longer.

`openInBrowser(link)` opens a page in a new window or tab with no `opener` and returns `false` when the browser blocked
it. `browserStepUp()` is a step-up handler built on it, for the second sign-in that Bypass needs. See
[Server-held grants and Bypass](server-grants.md#bypass).

### A browser extension

An extension uses the same packages in its service worker and its pages. It needs a place for the sign-in that outlives
the page: a `TokenStore` over `chrome.storage.local`, or `chrome.storage.session` for a sign-in per browser session. The
example is in [Build an agent](agent.md#in-a-browser-extension). An extension signs in by pairing, since it cannot ask
for a password the way a login page does: see [Sign in by pairing](agent.md#sign-in-by-pairing).

The chat view model takes the host's clipboard, link opener, download and preferences store, with no default (see
[The host's services](chat-panel.md#the-hosts-services)). An extension opens links its own way: pass `openLink` over
`browserChatServices()`, and set `openBrowser` on the `ApprovalBroker`, so a second sign-in opens in a tab of the
extension and not in a window the page opens.

### Node

Node has no IndexedDB, so the default session and approval stores are `MemorySessionStore` and `MemoryApprovalStore`:
the conversation lasts as long as the process, and the SDK writes nothing to disk and keeps no key. A service that must
keep conversations passes its own `SessionStore` and `ApprovalStore` and, to encrypt them, a `SecretProtector` over its
own key store (see [Encryption](sessions.md#encryption)). Because the stores are the host's, `deleteMyData` reports
`hostStoresLeft` and leaves them to you.

The sign-in is kept in memory unless you pass a `TokenStore`; a file that only the user can read is the usual choice.
`@fadenstack/testing` runs a fake server in the same process, and `FakeGateway.listen` serves it over HTTP on
`127.0.0.1` for a process that needs a URL.

## What the TypeScript SDK does not have

- **No dependency injection.** There is no `AddFadenstackAgent`. Create the agent where your application starts and pass
  it to what needs it.
- **No local MCP servers.** A browser cannot start a process. Tools that should be on request are host tools; see
  [Local tools](local-tools.md).
- **No file sink for logs.** The SDK hands its log entries to the logger you give it; see
  [Logging](agent.md#logging).
- **No OS key store.** Browsers get a WebCrypto key; a host that wants more supplies a `SecretProtector`.
