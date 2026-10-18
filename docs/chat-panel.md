# The chat panel

Put a ready-made chat with your agent into a React or Vue application, or bind the same view models to another
framework.

The UI comes in layers, and the split is strict:

- **`@fadenstack/ui`** holds all of the behaviour, as view models with no UI framework: the chat
  (`AgentChatViewModel`), its turns, the parts of each answer, the tool-mode picker, the history, attachments, an
  `ApprovalBroker` that turns approvals into cards in the chat, and every text the panel shows, in several languages.
- **`@fadenstack/ui-web`** holds the look every web skin shares: the stylesheet, the icons, the agent's avatar, and
  the panel's browser behaviours (staying at the bottom while an answer streams, closing a menu on a click outside).
- **`@fadenstack/ui-react`** and **`@fadenstack/ui-vue`** only render. Both draw the same markup with the same
  stylesheet, so the panel looks and behaves the same in either. A skin for Lit or another framework binds to the same
  view models and uses `@fadenstack/ui-web` the same way.

## Add the panel

=== "React"

    ```tsx
    import { createRoot } from "react-dom/client";
    import { FadenstackClient } from "@fadenstack/client";
    import { FadenstackAgent } from "@fadenstack/agents";
    import { AgentChatViewModel, ApprovalBroker, stringsFor } from "@fadenstack/ui";
    import { ChatPanel } from "@fadenstack/ui-react";
    import "@fadenstack/ui-web/styles.css";

    const { client } = FadenstackClient.forAgent({
      serverUrl: "https://ai.example.internal",
      agent: "my-assistant",
      store,
    });

    const approvals = new ApprovalBroker(); // approval cards in the chat decide
    const agent = FadenstackAgent.createBuilder()
      .useClient(client)
      .addTools(...tools)
      .useApprovals(approvals)
      .build();

    const chat = new AgentChatViewModel(agent, approvals, { automaticLanguage: navigator.languages, locale: navigator.language });
    await chat.initialize();
    createRoot(document.getElementById("chat")!).render(<ChatPanel chat={chat} />);
    ```

=== "Vue"

    ```ts
    import { createApp, h, markRaw } from "vue";
    import { FadenstackClient } from "@fadenstack/client";
    import { FadenstackAgent } from "@fadenstack/agents";
    import { AgentChatViewModel, ApprovalBroker, stringsFor } from "@fadenstack/ui";
    import { ChatPanel } from "@fadenstack/ui-vue";
    import "@fadenstack/ui-web/styles.css";

    const { client } = FadenstackClient.forAgent({
      serverUrl: "https://ai.example.internal",
      agent: "my-assistant",
      store,
    });

    const approvals = new ApprovalBroker(); // approval cards in the chat decide
    const agent = FadenstackAgent.createBuilder()
      .useClient(client)
      .addTools(...tools)
      .useApprovals(approvals)
      .build();

    const chat = markRaw(new AgentChatViewModel(agent, approvals, { automaticLanguage: navigator.languages, locale: navigator.language }));
    await chat.initialize();
    createApp({ render: () => h(ChatPanel, { chat }) }).mount("#chat");
    ```

    Keep the view model out of `ref()` and `reactive()`: a Vue proxy breaks its private fields. `markRaw` makes sure
    Vue never wraps it. The panel watches the view model itself.

Give the same `ApprovalBroker` to the builder and to the view model. Without a chat listening to it, the broker
declines every request.

`initialize()` starts the agent, reads its name, greeting and suggestions from the profile, and loads the session list.
It does not throw: a failure shows in `chat.error`. When the agent needs a sign-in, `chat.signInRequired` is true, and
the panel shows your sign-in instead of the conversation. Sign the user in, then call `initialize()` again:

=== "React"

    ```tsx
    <ChatPanel chat={chat} signIn={<SignInForm onSignedIn={() => void chat.initialize()} />} />
    ```

=== "Vue"

    ```vue
    <ChatPanel :chat="chat">
      <template #sign-in><SignInForm @signed-in="chat.initialize()" /></template>
    </ChatPanel>
    ```

Call `chat.dispose()` when you remove the panel. It stops a running turn and stops listening to the broker.

## What the panel shows

- **The answer streams as Markdown**: headings, lists, code blocks with a copy button, tables with a copy button,
  quotes and links. It is built as elements, never as HTML: HTML in an answer shows as text. Links open only for
  `http`, `https` and `mailto` addresses.
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
- **The settings** (the gear) have the language, your own items, and About last. See [Settings](#settings).
- **The composer** has context chips, Enter to send, Shift+Enter for a new line, and Esc to stop. Under it are the AI
  notice and a muted Fadenstack link. See [About and the Fadenstack link](#about-and-the-fadenstack-link).
- **After an answer**: copy (the Markdown as text, and as HTML so it pastes formatted into mail and documents), retry
  for a turn that failed or was stopped, edit, and the turn's duration and tokens.
- **An empty chat** shows the agent's avatar, its greeting, and its suggested prompts from the agent's profile.

It looks like part of the browser: Chrome's Material surfaces and blue, the system UI font, and native scroll bars
and controls. It follows the browser's light or dark setting as it changes.

The panel is built for long sessions. The agent's events reach the view models in batches, with streamed text
merged. A streaming answer parses only its newest block again, and blocks that did not change are not rendered again.
Turns out of view are not laid out. An opened session shows its latest turns first and loads older ones on request.

## Panel options

React takes everything as props. Vue takes values as props and your own content as slots.

| React prop | Vue | What it is |
|---|---|---|
| `chat` | prop `chat` | The `AgentChatViewModel`. Required. |
| `theme` | prop `theme` | `system` (default) follows the browser's light or dark setting; `light` or `dark` fixes one. |
| `headerExtra` | slot `#header-extra` | Your buttons in the header. |
| `settingsExtra` | slot `#settings-extra` | Your items in the panel's settings, below the language. See [Settings](#settings). |
| `composerAccessory` | slot `#composer-accessory` | Your controls in the composer, for example to attach the page or the selection. |
| `contextBar` | slot `#context-bar` | Shown above the composer, for example the page the agent works on. |
| `signIn` | slot `#sign-in` | Shown instead of the chat while the agent needs a sign-in. |
| `placeholder` | prop `placeholder` | The composer's placeholder. |
| `partRenderers` | prop `part-renderers` | Views for parts that modules add. See [Views for parts](#views-for-parts). |
| `agentColor` | prop `agent-color` | A colour for the middle plate of the agent's avatar. |
| `avatar` | slot `#avatar` | Replaces the agent's avatar in the empty chat, for example with your own logo. |
| `className` | `class` | More classes for the panel's root element. |

Both packages also export the panel's pieces (`ChatHeader`, `Composer`, `TurnView`, `PartView`, `Markdown`,
`AgentAvatar`, `Icon`), the view of each part (`ToolCallView`, `ApprovalView`, `MarkdownView`, ...), and
`useViewModel`: a hook in React, a composable in Vue that returns the view model as a ref which changes with it.

## Before a message goes

Your application may need to do something before each message is sent: check that the user may still send, take
the context its tools read, or attach a file. Do it in `beforeSend`, so it runs for every message, from the
composer, a suggestion, Retry, or Edit and resend:

```ts
const chat = new AgentChatViewModel(agent, approvals, {
  beforeSend: async (message, signal) => {
    await session.assertStillSignedIn(signal);
    activeFile = picker.current();
    if (!activeFile) throw new Error("Select a file first.");
    chat.attach({ title: activeFile.name, kind: "document", content: await activeFile.read(signal) });
  },
  afterSend: () => {
    activeFile = undefined;
  },
});
```

While `beforeSend` runs, the chat is busy and the composer shows Stop, which aborts `signal`. If it throws, nothing
is sent: the text stays in the composer and `chat.error` shows the message. Attachments it adds go with this message.
`afterSend` runs once after every send, however it ended: its turn finished, failed or was stopped, or `beforeSend`
threw.

## View model options

`new AgentChatViewModel(agent, approvals, options)` takes `AgentChatOptions`:

| Option | What it is |
|---|---|
| `automaticLanguage`, `languages`, `lockedLanguage`, `preferences` | The language the user picks in the settings, and where it is kept. See [Languages](#languages). |
| `strings` | Texts you fix instead of a language the user picks. |
| `locale` | The locale for dates and numbers. The browser's by default. |
| `beforeSend`, `afterSend` | What your application does around each message. See [Before a message goes](#before-a-message-goes). |
| `branding` | The muted Fadenstack link under the message box. On by default; `false` hides it. About stays. |
| `refSource` | Your app's name in the links to fadenstack.com. `sdk` by default. See [About and the Fadenstack link](#about-and-the-fadenstack-link). |
| `openLink` | How the panel opens its links. A new tab by default. |
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

## Views for parts

A module can add parts of its own to an answer, and your application can show any part its own way. A part renderer
gets each part and the texts, and returns a view, or nothing to leave the part to the built-in views. It is asked
again whenever the part changes. A renderer can keep the built-in view and add to it, for example search results above
the tool line that found them:

=== "React"

    ```tsx
    import { ToolCallPart } from "@fadenstack/ui";
    import { ToolCallView, type PartRenderer } from "@fadenstack/ui-react";

    const searchResults: PartRenderer = (part, strings) =>
      part instanceof ToolCallPart && part.name === "search_files" && part.state === "succeeded"
        ? <><SearchResults callId={part.callId} /><ToolCallView part={part} strings={strings} /></>
        : null;

    <ChatPanel chat={chat} partRenderers={[searchResults]} />
    ```

=== "Vue"

    ```ts
    import { h } from "vue";
    import { ToolCallPart } from "@fadenstack/ui";
    import { ToolCallView, type PartRenderer } from "@fadenstack/ui-vue";

    const searchResults: PartRenderer = (part, strings) =>
      part instanceof ToolCallPart && part.name === "search_files" && part.state === "succeeded"
        ? [h(SearchResults, { callId: part.callId }), h(ToolCallView, { part, strings })]
        : undefined;
    ```

    ```vue
    <ChatPanel :chat="chat" :part-renderers="[searchResults]" />
    ```

Every built-in part view takes `part` and `strings`.

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

The stylesheet is `@fadenstack/ui-web/styles.css`. (`@fadenstack/ui-react/styles.css` still works: it imports the
same file.) It sets the dark values with rules on `.fdn-chat[data-theme]`. To change a variable in every theme, give
the panel a class and set the variable in a rule that loads after the stylesheet:

```css
/* <ChatPanel chat={chat} className="my-panel" />, or in Vue <ChatPanel :chat="chat" class="my-panel" /> */
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
`@media (prefers-color-scheme: dark)` rule for `.fdn-chat.my-panel[data-theme="system"]`. To follow the colours of
the application around the panel, map its variables to the panel's in such a rule. In Windows contrast themes, the
stylesheet switches to the system's colours.

## Languages

The panels show no text of their own: every text is in the chat's `strings` (`UiStrings`). The SDK ships English,
German, French, Spanish and Simplified Chinese, in the console's words and its formal address.

**The user picks the language** in the panel's settings (the gear in the header): *Automatic*, or one of the
languages, each listed in its own name (Deutsch, Français, 中文（简体）), so anyone finds their own. The whole panel
changes at once, the conversation too, and the choice is remembered on the device and for the user: the server keeps
it, so their other agents, their other devices and the console follow it. Your application only says what
*Automatic* means, the language it runs in:

```ts
const chat = new AgentChatViewModel(agent, approvals, {
  automaticLanguage: navigator.languages, // or Office's language, the Nextcloud user's: "de-DE"
  locale: navigator.language,             // dates and numbers
});
```

Without `automaticLanguage`, *Automatic* is the browser's languages. A locale finds the nearest language from the most
specific tag to the language alone: `de-AT` gets German, `zh-CN` Simplified Chinese; `zh-TW` is Traditional, which
is not shipped, and gets English unless you add it.

| Option | What it is |
|---|---|
| `automaticLanguage` | What *Automatic* means: a locale, or several, best first. |
| `languages` | The languages to pick from, by tag: `builtInStrings` by default. |
| `lockedLanguage` | A language your organisation fixed, from its policy: the panel uses it, and the settings show it with *Set by your organisation* and no choice. |
| `preferences` | Where the choice is kept (`PreferenceStore`). `browserPreferences()` by default: the browser's `localStorage`, so every panel of the site or extension shares it; memory where there is none. Pass your own for an extension's storage or your application's settings. |
| `strings` | Texts you fix instead: the panel then offers no choice. |

`chat.setLanguage("fr")` and `chat.setLanguage("auto")` do from code what the settings do, and `chat.language`,
`chat.languageOptions` and `chat.canChangeLanguage` say what they show.

**The language follows the user.** The agent's profile carries the language the user picked anywhere
(`agent.profile.user.language`, a tag such as `de` or `zh-Hans`), and the panel takes it over the device's when it
starts, if it offers that language (`zh` is Simplified Chinese; a language it lacks changes nothing). A pick in the
settings is sent back (`agent.setUserLanguage(tag)`, `PATCH /v1/agents/{agent}/user`); *Automatic* sends `null`,
so each client follows its host again. A server that cannot keep it, or an older one without the route, leaves the
pick on the device. A language your organisation locked is never sent, and a language from the server never
overrides it.

To add a language, write a full `UiStrings`, with its `language` tag and its name in itself, and offer it next to the
built-in ones. To change a language's words, change only those; what you leave out comes from the language you name:

```ts
import { builtInStrings, germanStrings, withStrings, type UiStrings } from "@fadenstack/ui";

const italianStrings: UiStrings = { language: "it", direction: "ltr", languageName: "Italiano", send: "Invia", /* ... every text */ };
const chat = new AgentChatViewModel(agent, approvals, {
  languages: {
    ...builtInStrings,
    it: italianStrings,
    de: withStrings({ composerPlaceholder: "Fragen Sie zu dieser Datei" }, germanStrings),
  },
});
```

The groups `toolClass`, `approvalClass`, `approvalWhy`, `noticeTitles` and `modes` are completed key by key, so you
can change one mode's words and keep the others. `stringsFor(locale)` picks a language's texts outside a chat.

The panel's root element carries the texts' `lang` and their `dir`. A language that runs right to left, such as
Arabic or Hebrew, sets `direction: "rtl"`, and the whole panel mirrors: the stylesheet's directions are logical. The
user's messages and the answers take their direction from their own text, so a Hebrew answer reads right to left in
an English panel, and code always runs left to right. Dates and numbers follow `locale`.

## The AI notice

Under the message box the panel says, in the user's language, that the answers are generated by AI and can be wrong
(`strings.aiNotice`). The EU AI Act asks that people know they are dealing with an AI system, and agents built on
the SDK act for a person on pages, documents and mails. Change its words like any other text; an empty `aiNotice`
hides it, for an application that says the same in another place the user always sees.

## About and the Fadenstack link

The settings end with **About**. It opens over the panel, below the gear, and shows the agent (its name, `Version 3`
or `Draft`, and its model), the app it runs in when you described it (`describeApp`), the SDK's version, and the
server's address. Its links go to your organisation's Help on the agent's server (`<server>/help/`), to
fadenstack.com, and to the developer docs. *Copy details* copies all of it as text lines, for a support request.
Escape, the close button or a press outside closes it.

Under the AI notice, on a small line of its own, the panel shows a muted **Fadenstack** link to fadenstack.com.
`branding: false` hides that line; the notice and About stay.

```ts
const chat = new AgentChatViewModel(agent, approvals, {
  refSource: "my-crm",                            // ref=my-crm-panel and ref=my-crm-about
  branding: false,                                // no Fadenstack link under the message box
  openLink: (url) => chrome.tabs.create({ url }), // how your host opens a link (here an extension's tab)
});
```

**What a link sends.** A link to fadenstack.com carries two values and nothing else: `ref`, where the click came from
(`<refSource>-panel` or `<refSource>-about`), and `v`, the SDK's major.minor version. For example
`https://fadenstack.com/?ref=sdk-panel&v=0.2`. Nothing about the user, the organisation, the server or the agent is in
it. The link has `rel="noopener noreferrer"`, so the browser sends no Referer and internal addresses stay inside. The
Help link goes to your own server and carries nothing. The server's address in About is only shown, never sent.

`refSource` names your app: lower-case letters and digits, words joined by single hyphens, at most 20 characters
(`my-crm`). Anything else falls back to `sdk`. Do not put a customer, tenant or host name in it.

Links open in a new tab through `openLink`, by default `window.open(url, "_blank", "noopener,noreferrer")`. A host
that opens links its own way, such as an Office add-in or a browser extension, passes its own. Screen readers hear that
each link opens in a new tab.

`chat.setAboutOpen(true)`, `chat.about` and `chat.copyAboutDetails()` do from code what About does. For a skin of
your own, `@fadenstack/ui` exports the link helpers: `fadenstackLink`, `footerLink`, `helpLink`, `refSource` and
`majorMinor`.

## Settings

The gear in the header opens the panel's settings: the language, and below it what your application adds, such as
sign out or its own options, so they all sit in one place:

=== "React"

    ```tsx
    <ChatPanel chat={chat} settingsExtra={<button type="button" className="fdn-menu-item" onClick={signOut}>Sign out</button>} />
    ```

=== "Vue"

    ```vue
    <ChatPanel :chat="chat">
      <template #settings-extra><button type="button" class="fdn-menu-item" @click="signOut">Sign out</button></template>
    </ChatPanel>
    ```

The gear is always there: its last item is About, below your items. See
[About and the Fadenstack link](#about-and-the-fadenstack-link).

## View models for other frameworks

Each view model is observable: `subscribe(listener)` calls the listener after each change and returns the unsubscribe,
and `version` grows with every change. Collections are replaced, never changed in place, so a skin compares them by
reference. Each turn and each part is its own view model, so one change re-renders one view.

| View model | What it holds |
|---|---|
| `AgentChatViewModel` | The chat: `turns`, `input`, `attachments`, `sessions`, `toolModes`, `toolMode`, `greeting`, `suggestions`, `isBusy`, `signInRequired`, `error`, `strings`, `about`, `footerLink`, and the actions `send`, `stop`, `newChat`, `openSession`, `loadEarlier`, `selectToolMode`, `setAboutOpen`, `openLink`. |
| `TurnViewModel` | One exchange: `userText`, `parts`, `state`, `outcome`, `usageText`, `durationText`, and `copy`, `edit`, `retry`. |
| `ResponsePart` | One part of an answer, with a `kind`: `markdown`, `reasoning`, `tool`, `approval`, `notice`, `citations`, and `card`, `table`, `progress` and `diff` for modules. |
| `AttachmentViewModel` | One context chip. |

A turn's `state` is `running`, `waiting_for_approval`, `completed`, `blocked`, `stopped` or `failed`.

A new skin draws the classes of `@fadenstack/ui-web/styles.css` and takes the rest from `@fadenstack/ui-web`:
`iconPaths` for the icons, `agentAvatar()` for the avatar as SVG data, `stickToBottom`, `dismissOnOutside`,
`fitToContent` and `composerKey` for the behaviours, and `toolBadges`, `toolStatusIcon`, `noticeIcon` and the others
for how parts look. The React and Vue skins are the examples.
