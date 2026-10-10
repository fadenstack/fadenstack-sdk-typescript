# The chat panel

Put a ready-made chat with your agent into a React application, or bind the same view models to another framework.

The UI comes in two packages, and the split is strict:

- **`@fadenstack/ui`** holds all of the behaviour, as view models with no UI framework: the chat
  (`AgentChatViewModel`), its turns, the parts of each answer, the tool-mode picker, the history, attachments, and an
  `ApprovalBroker` that turns approvals into cards in the chat.
- **`@fadenstack/ui-react`** only renders. Its `ChatPanel` binds the view models with React's
  `useSyncExternalStore`. A skin for Vue, Lit or another framework binds to the same view models.

## Add the panel

```tsx
import { createRoot } from "react-dom/client";
import { FadenClient } from "@fadenstack/client";
import { FadenAgent } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import "@fadenstack/ui-react/styles.css";

const { client } = FadenClient.forAgent({
  serverUrl: "https://ai.example.internal",
  agent: "my-assistant",
  store,
});

const approvals = new ApprovalBroker(); // approval cards in the chat decide
const agent = FadenAgent.createBuilder()
  .useClient(client)
  .addTools(...tools)
  .useApprovals(approvals)
  .build();

const chat = new AgentChatViewModel(agent, approvals);
await chat.initialize();
createRoot(document.getElementById("chat")!).render(<ChatPanel chat={chat} />);
```

Give the same `ApprovalBroker` to the builder and to the view model. Without a chat listening to it, the broker
declines every request.

`initialize()` starts the agent, reads its name, greeting and suggestions from the profile, and loads the session list.
It does not throw: a failure shows in `chat.error`. When the agent needs a sign-in, `chat.signInRequired` is true, and
the panel shows what you pass as `signIn` instead of the conversation. Sign the user in, then call `initialize()`
again:

```tsx
<ChatPanel chat={chat} signIn={<SignInForm onSignedIn={() => void chat.initialize()} />} />
```

Call `chat.dispose()` when you remove the panel. It stops a running turn and stops listening to the broker.

## What the panel shows

- **The answer streams as Markdown**: headings, lists, code blocks with a copy button, tables with a copy button,
  quotes and links. It is built as React elements, never as HTML: HTML in an answer shows as text. Links open only
  for `http`, `https` and `mailto` addresses.
- **Remote images are never loaded**: no image in an answer is, because a remote image can carry data out. An image
  shows as its alternative text in brackets, with its address as the tooltip.
- **Text and tool calls interleave** in the order they happened.
- **Each tool call is one line**, "Running read_page" and then "Ran read_page", with its duration. Your tools that
  are not `read` show their class, and server tools a badge. The line expands to the tool's input and output.
- **Approvals are cards** with Allow, Allow for this chat, Allow always and Deny, above their tool's line. A tool
  that cannot be undone or that nobody classified, and a call an administrator's rule asks about, offer Allow and Deny
  only: they ask every time.
- **Refusals and limits are notices.** A refused prompt is marked "Not sent", with Edit and resend.
- **Reasoning and citations** are collapsible. A PII notice says how many values of which kind were kept from the
  model.
- **The header** has the agent's name, the tool mode, the history (open or delete a chat), a new chat, and your
  own buttons. The tool-mode menu ends with Reset approvals, which forgets what was allowed for this chat and always
  (`chat.resetApprovals()`).
- **The composer** has context chips, Enter to send, Shift+Enter for a new line, and Esc to stop.
- **After an answer**: copy (the Markdown as text, and as HTML so it pastes formatted into mail and documents), retry
  for a turn that failed or was stopped, edit, and the turn's duration and tokens.
- **An empty chat** shows the agent's avatar, its greeting, and its suggested prompts from the agent's profile.

It looks like part of the browser: Chrome's Material surfaces and blue, the system UI font, and native scroll bars
and controls. It follows the browser's light or dark setting as it changes.

The panel is built for long sessions. The agent's events reach the view models in batches, with streamed text
merged. A streaming answer parses only its newest block again, and blocks that did not change are not rendered again.
Turns out of view are not laid out. An opened session shows its latest turns first and loads older ones on request.

## Panel options

| Prop | What it is |
|---|---|
| `chat` | The `AgentChatViewModel`. Required. |
| `theme` | `system` (default) follows the browser's light or dark setting; `light` or `dark` fixes one. |
| `headerExtra` | Your buttons in the header, for example settings or sign out. |
| `composerAccessory` | Your controls in the composer, for example to attach the page or the selection. |
| `contextBar` | Shown above the composer, for example the page the agent works on. |
| `signIn` | Shown instead of the chat while the agent needs a sign-in. |
| `placeholder` | The composer's placeholder. |
| `partRenderers` | Views for parts that modules add. Tried before the built-in views. |
| `agentColor` | A colour for the middle plate of the agent's avatar. |
| `avatar` | Replaces the agent's avatar in the empty chat, for example with your own logo. |
| `className` | More classes for the panel's root element. |

`@fadenstack/ui-react` also exports the panel's pieces (`ChatHeader`, `Composer`, `TurnView`, `PartView`,
`Markdown`, `AgentAvatar`) and the hook `useViewModel`, for a layout of your own.

## View model options

`new AgentChatViewModel(agent, approvals, options)` takes `AgentChatOptions`:

| Option | What it is |
|---|---|
| `strings` | Texts in another language, or in your own words. See below. |
| `locale` | The locale for dates and numbers. The browser's by default. |
| `previewLength` | How many characters of a tool's input and output are shown. Default 4 000. |
| `initialTurns` | How many turns an opened session shows at first. |
| `pageSize` | How many older turns "Show earlier messages" adds. |
| `renderIntervalMs` | How often streamed updates reach the view models, in milliseconds. The default suits a chat panel. |
| `renderers` | Renderers for server events, tried before the built-in ones. |
| `clipboard` | The clipboard. The browser's by default. |
| `scheduler` | When batched work runs. `setTimeout` by default; `immediateScheduler` runs it at once, for tests. |
| `now` | The clock, for tests. |

## Context chips

Context the user sends with the next message shows as a chip in the composer. `chat.attach(content)` adds a chip
whose content you already have. For content that should be read when the message is sent, such as the current
selection, create an `AttachmentViewModel` with a `resolve` function:

```ts
import { AttachmentViewModel } from "@fadenstack/ui";

const page = new AttachmentViewModel({
  title: document.title,
  subtitle: "Page",
  implicit: true,
  resolve: async () => ({ title: document.title, kind: "page", content: readPageAsMarkdown() }),
});
chat.addAttachment(page);
```

An implicit chip is one your application offers, like the current page. It stays between messages, and the user can
switch it off and on. Change what it says with `page.update(title, subtitle)`, and remove it with
`chat.removeAttachment(page)`. Other chips go with the next message and are then cleared.

## Theming

The panel's colours, corner radius and fonts are CSS variables on `.fdn-chat`:

| Variables | What they set |
|---|---|
| `--fdn-bg`, `--fdn-surface`, `--fdn-surface-high`, `--fdn-surface-hover` | Backgrounds and surfaces |
| `--fdn-text`, `--fdn-text-muted`, `--fdn-text-faint` | Text |
| `--fdn-border`, `--fdn-hairline` | Borders and dividers |
| `--fdn-accent`, `--fdn-on-accent`, `--fdn-accent-soft`, `--fdn-on-accent-soft` | The accent, and text on it |
| `--fdn-danger`, `--fdn-danger-soft`, `--fdn-warning`, `--fdn-warning-soft`, `--fdn-success` | States |
| `--fdn-code-bg`, `--fdn-focus`, `--fdn-shadow` | Code blocks, the focus ring, shadows |
| `--fdn-radius`, `--fdn-font`, `--fdn-mono` | Corner radius and fonts |
| `--fdn-agent-plate`, `--fdn-agent-plate-side`, `--fdn-agent-thread`, `--fdn-agent-thread-side`, `--fdn-agent-hollow`, `--fdn-agent-eye`, `--fdn-agent-pupil` | The agent's avatar |

The stylesheet sets the dark values with rules on `.fdn-chat[data-theme]`. To change a variable in every theme, give
the panel a class and set the variable in a rule that loads after `styles.css`:

```css
/* <ChatPanel chat={chat} className="my-panel" /> */
.fdn-chat.my-panel {
  --fdn-accent: #4c6a92;
  --fdn-focus: #4c6a92;
}

.fdn-chat.my-panel[data-theme="dark"] {
  --fdn-accent: #9fb8d8;
  --fdn-focus: #9fb8d8;
}
```

The second rule covers `theme="dark"`. With `theme="system"`, put the dark values in a
`@media (prefers-color-scheme: dark)` rule for `.fdn-chat.my-panel[data-theme="system"]`. In Windows contrast themes,
the stylesheet switches to the system's colours.

## Other languages

Every text the panel shows is in `UiStrings`, English by default. Pass the texts you change as `strings`; the rest
stay English:

```ts
import { AgentChatViewModel, englishStrings } from "@fadenstack/ui";

const chat = new AgentChatViewModel(agent, approvals, {
  locale: "de-DE",
  strings: {
    send: "Senden",
    stop: "Stoppen",
    newChat: "Neuer Chat",
    composerPlaceholder: "Frag etwas",
    toolRunning: (name) => `${name} läuft`,
    toolRan: (name) => `${name} ausgeführt`,
    noticeTitles: { prompt_blocked: "Deine Nachricht wurde nicht gesendet" },
    modes: {
      ...englishStrings.modes,
      ask: { label: "Fragen", description: "Fragt, bevor sich etwas ändert." },
    },
  },
});
```

The groups `toolClass`, `approvalClass`, `approvalWhy`, `noticeTitles` and `modes` are merged with the English ones
key by key. `noticeTitles` takes single entries; the other groups have a fixed set of keys, so spread the English
group and change what you need, as with `modes` above. `englishStrings` is the full English set to start a
translation from.

## View models for other frameworks

Each view model is observable: `subscribe(listener)` calls the listener after each change and returns the unsubscribe,
and `version` grows with every change. Collections are replaced, never changed in place, so a skin compares them by
reference. Each turn and each part is its own view model, so one change re-renders one view.

| View model | What it holds |
|---|---|
| `AgentChatViewModel` | The chat: `turns`, `input`, `attachments`, `sessions`, `toolModes`, `toolMode`, `greeting`, `suggestions`, `isBusy`, `signInRequired`, `error`, and the actions `send`, `stop`, `newChat`, `openSession`, `loadEarlier`, `selectToolMode`. |
| `TurnViewModel` | One exchange: `userText`, `parts`, `state`, `outcome`, `usageText`, `durationText`, and `copy`, `edit`, `retry`. |
| `ResponsePart` | One part of an answer, with a `kind`: `markdown`, `reasoning`, `tool`, `approval`, `notice`, `citations`, and `card`, `table`, `progress` and `diff` for modules. |
| `AttachmentViewModel` | One context chip. |

A turn's `state` is `running`, `waiting_for_approval`, `completed`, `blocked`, `stopped` or `failed`.
