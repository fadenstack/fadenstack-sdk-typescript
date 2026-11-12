# Libraries

This page covers the SDK's eight packages: what each is for, what it needs, and which to add for what you build. All of them are released together with one version; keep them on the same version.

## What each package is for

| Package | Use it to | Main exports |
|---|---|---|
| `@fadenstack/client` | Talk to the server without an agent loop: plain chat completions, signing in, the agent's profile and events, typed errors. The base of the others; it needs nothing. | `FadenstackClient`, `AgentTokenProvider`, `AgentPairing`, `loginWithPassword`, `FadenstackError` and its subclasses, `FadenstackLogger`, `AgentResource` |
| `@fadenstack/agents` | Run an agent on the device: the builder, the tool loop, tool classes and modes, approvals, grants, sessions, outcomes, stages and modules. | `FadenstackAgent`, `AgentBuilder`, `AgentSession`, `defineTool`, `ApprovalDecision`, `StageOrder`, `IndexedDbSessionStore`, `OnRequestTools` |
| `@fadenstack/ui` | Build a chat for an agent in any framework. It holds the state and no markup: view models, the approval broker, the built-in texts in five languages, the Markdown parser. | `AgentChatViewModel`, `TurnViewModel`, `ApprovalBroker`, `builtInStrings`, `MarkdownDocument` |
| `@fadenstack/ui-web` | Give a skin its look and browser behaviours: the stylesheet (`@fadenstack/ui-web/styles.css`), icons, the agent's avatar, scrolling, focus and the composer's keys. For a skin of your own; the React and Vue skins use it. | `iconPaths`, `agentAvatar`, `stickToBottom`, `dismissOnOutside`, `composerKey` |
| `@fadenstack/ui-react` | Put the finished chat panel in a React application. | `ChatPanel`, `useViewModel` |
| `@fadenstack/ui-vue` | Put the same chat panel in a Vue application. | `ChatPanel`, `useViewModel` |
| `@fadenstack/testing` | Test an agent without a server: a fake server with a scripted model, a fake for grants, helpers to run a tool by hand. Add it as a development dependency. | `FakeGateway`, `FakeGrants`, `toolContext` |
| `@fadenstack/provenance` | Mark what the agent's tools write as made with AI: `place()`, markers for the places the content lands, signed records, placement reports. Added to the builder as a module. | `provenanceModule`, `Provenance`, `provenanceOf`, `ProvenanceReader` |

[Testing without a server](testing.md) covers `@fadenstack/testing`, and [Marking AI-generated content](provenance.md)
covers `@fadenstack/provenance`. `@fadenstack/testing` has a second entry, `@fadenstack/testing/provenance`, for the
fake provenance.

## What depends on what

- `agents` builds on `client`.
- `ui` builds on `agents` and `client`.
- `ui-web` builds on `ui`; `ui-react` and `ui-vue` build on `ui-web`, `ui`, `agents` and `client`.
- `provenance` builds on `agents`, `client` and `ui` (for its texts).
- `testing` builds on `client`, and has `agents` and `provenance` as peer dependencies.

`@fadenstack/ui` also needs `marked` for Markdown. `@fadenstack/ui-react` has React and React DOM 18.2 or later as peer
dependencies, and `@fadenstack/ui-vue` has Vue 3.5 or later. The table in the [overview](index.md#dependencies) lists
every dependency.

## Which to add

| You build | Add |
|---|---|
| A script or a service that chats with an agent | `client`, `agents` |
| A page or an extension with a chat panel | `client`, `agents`, `ui`, `ui-web`, and `ui-react` or `ui-vue` |
| A chat in another framework | `client`, `agents`, `ui`, `ui-web`, and your own skin |
| An agent whose tools write content people read | the above, and `provenance` |
| Tests | `testing`, as a development dependency |
| Plain chat completions without an agent | `client` only; see [Plain chat completions](plain-api.md) |

## Building a library on the SDK

A library that builds on the SDK, such as a shared set of host tools or a module, is a package of its own:

- Depend on the SDK packages you use, and list `@fadenstack/agents` as a peer dependency when your library hands tools
  or a module to the application's builder, so the application and your library share one copy.
- A module is a `FadenstackModule` with a `name` and a `configure(builder)` method; see [Extending](extending.md).
- Publish ES modules with type declarations, as the SDK does. The SDK uses standard web APIs only (`fetch`, Web Streams,
  Web Crypto, `AbortSignal`), so a library that does the same runs in a browser, an extension and Node.

The .NET SDK has to target `netstandard2.0` and `net8.0` for a library; the TypeScript packages have no such split, so
there is nothing to match.
