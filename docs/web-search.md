# Pictures and web search

## Pictures

In governed mode the agent makes pictures through the organisation's server, which marks them: signed metadata and a watermark. In standalone mode the SDK offers no picture tools in 0.3.0. The device cannot yet add both kinds of mark on its own, and the AI Act's marking rules expect them. Pictures the person attaches for the model to see are not affected. The Chrome agent makes no pictures in 0.3.0.

## The web search tool

`web_search` is one of the SDK's own tools, in `@fadenstack/agents`. Add its module, and the person picks a provider:

```ts
import { webSearchModule, IndexedDbWebSearchStore } from "@fadenstack/agents";

const agent = FadenstackAgent.createBuilder()
  .useEndpoint(endpoint).useLocalProfile(definition)
  .use(webSearchModule())
  .build();

const settings = new IndexedDbWebSearchStore();            // the standalone person's; pass { principal } for another
await settings.save({ provider: "brave" });
await settings.setBraveKey(keyThePersonTyped);             // sealed, never shown back
```

**Providers:**

| Provider | What the person gives | How it is asked |
|---|---|---|
| Brave Search API | Their own key (`setBraveKey`) | `GET https://api.search.brave.com/res/v1/web/search`, the key in `X-Subscription-Token` |
| SearXNG | The instance's address, with its JSON format turned on | `GET <address>/search?q=...&format=json` |

A SearXNG address must be https, or plain http on this computer only (`isAllowedSearxngUrl`). An address with a user or a password is refused. In a browser the host needs permission for the provider's origin. The Chrome agent keeps the browser's own search and does not use this tool.

**When it is offered.** The tool is offered only when all of these hold:
- the person picked a provider, with its key or address;
- this computer's policy allows it (`MachinePolicy.webSearch`; see [Machine policy](machine-policy.md));
- in governed mode, the administrator allows local tools for this agent (the profile's `local_mcp.mode` is `allow`), until the server has a switch of its own.

The agent asks for its tools again at its next turn after the person changes the settings.

**How it asks.** `web_search` is a read tool that is open-world: what it is given leaves the organisation. Below Auto a call asks, and the person can allow it for this conversation at most ([Tools and approvals](tools.md)). Auto and Bypass run it. A Fadenstack gateway knows the name and keeps it open-world under any rule; `@fadenstack/testing`'s `FakeGateway` does the same.

**The result** is up to 10 items, each with a title, an address and a snippet. A search that takes longer than 10 seconds ends with no results. The result is untrusted text: web pages wrote it. The SDK cleans each line, removing markup, control characters and invisible or direction marks, and keeps only http and https addresses. It then fences the result with a tag that changes on every search, and tells the model to treat it as data, never as instructions (OWASP Top 10 for LLM Applications 2025, LLM01).

**What is kept and logged.**
- The settings and the sealed Brave key go in the person's own database, `fadenstack-web-search`. The key is sealed with the person's WebCrypto key; without one, a key is refused rather than kept in the clear.
- Deleting the person's data removes the database. The export holds the settings, never the key ([Data on the device](data-on-device.md)).
- The log holds the provider, the number of results, the duration and the kind of a failure (events 2080 to 2082), never the query, a result or the key.
- Without IndexedDB, `MemoryWebSearchStore` keeps the settings for the run.

`WebSearchOptions` sets the timeout (`timeoutMs`), the number of results (`maxResults`, at most 10), the person's store (`store`), the `fetch`, and the `logger`. The .NET SDK has the same tool (`WebSearchModule`).

## The settings sheet

The person picks the provider in a sheet: **Off**, **Brave Search** with their own key, or a **SearXNG** address. The sheet is `WebSearchSettingsViewModel` in `@fadenstack/ui`, made from the person's `WebSearchStore`. It comes in React (`WebSearchSettings` in `@fadenstack/ui-react`) and in Vue (`WebSearchSettings` in `@fadenstack/ui-vue`), in the four skins' texts and the five languages. The .NET SDK has the same sheet (`WebSearchSettingsViewModel`, `WebSearchSettingsView`).

**What the person sees.**
- The Brave key goes in a password box (`autocomplete="off"`). It is never filled from the store: a kept key shows as "A key is saved" with **Replace key** and **Remove key**. Remove key takes effect when the sheet is saved; Cancel keeps the key.
- A SearXNG address is checked with `isAllowedSearxngUrl` before it is saved. A refused address says why: https, or http on this computer only, without a user name or password.
- Save writes the settings and then the key (`setBraveKey`). Choosing Off or SearXNG keeps a saved Brave key unless Remove key was pressed. Cancel writes nothing.
- A line says the key is kept encrypted in the device's key store and never shown again, and that a search sends the words of the query outside the organisation and the assistant asks first, unless it is set to Auto.
- The typed key is cleared from the view model after Save, after Cancel and on `dispose()`.

**In the Tools page.** Give the page the person's store and "In this app" shows a "Web search" row with the state (Off, Brave, "SearXNG · host") and a **Set up** or **Change** button that opens the sheet in place of the list. Without a store there is no row.

```ts
const store = new IndexedDbWebSearchStore({ principal });          // or MemoryWebSearchStore
const tools = new ToolsPageViewModel({ catalog, webSearch: store });
```

**On its own.** An app with a Tools page of its own (the desktop) shows the same sheet as a view:

```tsx
const settings = new WebSearchSettingsViewModel({ store, strings, onClose: () => back() });
await settings.ready;
<WebSearchSettings settings={settings} />        // Vue: <WebSearchSettings :settings="settings" />
```

`onClose` runs after Save and after Cancel; leave it out and the view says "Saved." and stays. Call `retext()` when the app's language changes and `dispose()` when the view goes.
