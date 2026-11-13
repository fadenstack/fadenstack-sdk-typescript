# The chat panel

Put a ready-made chat with your agent into a React or Vue application, or bind the same view models to another
framework.

The UI comes in layers, and the split is strict:

- **`@fadenstack/ui`** holds all of the behaviour, as view models with no UI framework and no browser API: the chat
  (`AgentChatViewModel`), its turns, the parts of each answer, the tool-mode picker, the history, attachments, an
  `ApprovalBroker` that turns approvals into cards in the chat, and every text the panel shows, in several languages.
  What only the host can do (copy, open a link, save a file, keep the user's choices) it asks of the host.
- **`@fadenstack/ui-web`** holds the look every web skin shares: the stylesheet, the icons, the agent's avatar, the
  panel's browser behaviours (staying at the bottom while an answer streams, closing a menu on a click outside), and
  the browser's ways for what the chat asks of its host (`browserChatServices()`, see [The host's services](#the-hosts-services)).
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
    import { browserChatServices } from "@fadenstack/ui-web";
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

    const chat = new AgentChatViewModel(agent, approvals, {
      ...browserChatServices(), // the browser's clipboard, links, downloads and kept choices
      automaticLanguage: navigator.languages,
      locale: navigator.language,
    });
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
    import { browserChatServices } from "@fadenstack/ui-web";
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

    const chat = markRaw(new AgentChatViewModel(agent, approvals, {
      ...browserChatServices(), // the browser's clipboard, links, downloads and kept choices
      automaticLanguage: navigator.languages,
      locale: navigator.language,
    }));
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
- **Quotes and list items hold blocks**, three levels deep: a table, a list or a code block inside a quote or an item
  is drawn as one. A quote, a list item or a Markdown preview inside three others does not nest further: the content of
  a container at the third level is one block of plain text, with its markup as typed (a thousand `>` cost three levels,
  and the text is kept, not dropped). The cap sits in the parser (`MAX_NESTING_DEPTH`), so lexing is bounded too.
- **A `markdown` (or `md`) fence is a preview**: its content drawn, with a Preview / Source switch above it. It counts as
  one level of nesting. In the view model it is a block of kind `preview` (`source` is the fence as a code block,
  `blocks` its content). A `mermaid` fence is a code block with `diagram: true`, labelled "Diagram - Mermaid"; it is shown
  as text, not drawn.
- **Remote images are never loaded**: no image in an answer is, because a remote image can carry data out. An image
  shows as its alternative text in brackets, with its address as the tooltip.
- **Text and tool calls interleave** in the order they happened.
- **Each tool call is one line**, "Running read_page" and then "Ran read_page", with its duration. Your tools that
  are not `read` show their class, and server tools a badge. The line expands to the tool's input and output.
- **Approvals are cards** with Allow, Allow for this chat, Allow always and Deny, above their tool's line. A tool
  that cannot be undone or that nobody classified, and a call an administrator's rule asks about, offer Allow and Deny
  only: they ask every time. The title has a row of its own, with the tool's name in code; under it are the class and,
  for a tool from a local MCP server, where it comes from ("From Files, an MCP server on this computer") with the
  server's own hint (only reads, may delete or overwrite). A chat opened again draws the same cards. In the view model:
  `ApprovalPart.titleParts`, `sourceLine`, `hasSourceLine` and `reason`.
- **Refusals and limits are notices.** A refused prompt is marked "Not sent", with Edit and resend.
- **Reasoning and citations** are collapsible. A PII notice says how many values of which kind were kept from the
  model.
- **The header** has the agent's name, the tool mode, the thinking pill (how long the agent thinks: see
  [Thinking](#thinking)), the history (open or delete a chat), a new chat, and your own buttons. The tool-mode menu ends with Reset approvals, which forgets what was allowed for this chat and always
  (`chat.resetApprovals()`).
- **The settings** (the gear) have the language, the switch for the notice about answers without an AI mark, the
  approvals, your own items, and About last. See [Settings](#settings).
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
  ...browserChatServices(),
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

`new AgentChatViewModel(agent, approvals, options)` takes `AgentChatOptions`: the host's four services, which it must
pass (see [The host's services](#the-hosts-services)), and these, which all have a default:

| Option | What it is |
|---|---|
| `automaticLanguage`, `languages`, `lockedLanguage` | The language the user picks in the settings. See [Languages](#languages). |
| `strings` | Texts you fix instead of a language the user picks. |
| `locale` | The locale for dates and numbers. The browser's by default. |
| `beforeSend`, `afterSend` | What your application does around each message. See [Before a message goes](#before-a-message-goes). |
| `beforeCommand`, `afterCommand` | What your application does around a host command the person starts (`chat.invokeTool`). See [Host commands](#host-commands). |
| `turnGate` | Limits how many turns work at the same time across chats. See [Limiting running turns](#limiting-running-turns). |
| `branding` | The muted Fadenstack link under the message box. On by default; `false` hides it. About stays. |
| `refSource` | Your app's name in the links to fadenstack.com. `sdk` by default. See [About and the Fadenstack link](#about-and-the-fadenstack-link). |
| `previewLength` | How many characters of a tool's input and output are shown. Default 4 000. |
| `initialTurns` | How many turns an opened session shows at first. |
| `pageSize` | How many older turns "Show earlier messages" adds. |
| `renderIntervalMs` | How often streamed updates reach the view models, in milliseconds. The default suits a chat panel. |
| `renderers` | Renderers for server events, tried before the built-in ones. |
| `scheduler` | When batched work runs. `setTimeout` by default; `immediateScheduler` runs it at once, for tests. |
| `now` | The clock, for tests. |
| `prompts` | The user's saved prompts (`PromptStore`): `browserPromptStore()` from `@fadenstack/ui-web`, `MemoryPromptStore`, or your own. Without one the panel has no saved prompts. |

### The host's services

Four things only the host can do, and `@fadenstack/ui` has no default for them: a view model without one does not
compile, so a host never loses the user's choices without noticing.

| Option | What it is | In a web page (`@fadenstack/ui-web`) |
|---|---|---|
| `clipboard` | Copies a message, a code block or a table (`Clipboard`). | `browserClipboard` |
| `openLink` | Opens the panel's links (About, the Fadenstack link). | `browserOpenLink`: a new tab, `noopener,noreferrer` |
| `saveFile` | Saves a file the panel makes: a table as CSV, a chat as Markdown (`SaveFile`). | `browserSaveFile`: the browser's download |
| `preferences` | Keeps the user's choices: the language they picked, the unmarked-answer notice (`PreferenceStore`). | `browserPreferences()`: `localStorage`, as `fadenstack.<name>`; memory where there is none |

`browserChatServices()` returns all four. A host that does one of them its own way passes that one over the
browser's:

```ts
import { browserChatServices } from "@fadenstack/ui-web";

const chat = new AgentChatViewModel(agent, approvals, {
  ...browserChatServices(),
  openLink: (url) => chrome.tabs.create({ url }), // an extension's tab
  preferences: myUserSettings,                     // the user's settings on your server
});
```

Outside a browser (a test, a headless host), `MemoryClipboard` and `MemoryPreferenceStore` keep everything in memory.

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
  ...browserChatServices(),
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
| `preferences` | Where the choice is kept (`PreferenceStore`), one of [the host's services](#the-hosts-services). `browserPreferences()` (`@fadenstack/ui-web`) keeps it in the browser's `localStorage`, so every panel of the site or extension shares it; memory where there is none. Pass your own for an extension's storage or your application's settings. |
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
  ...browserChatServices(),
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

### An answer without an AI mark

An administrator can allow a model route to answer without a machine-readable AI mark (EU AI Act Art. 50(2)). The server
then sends a `faden.unmarked` event with the answer. The panel **hides it by default**: no notice appears, and the raw
event name is never shown. Each person can turn the notice on in the panel's settings ("Tell me when an answer carries no
AI mark"). From then on, one quiet notice ("Answer without an AI mark") sits on each such answer.

In the view model, `chat.showUnmarkedNotice` is the state and `await chat.setShowUnmarkedNotice(on)` changes it and
remembers it. It applies to the answers that come after. The setting is a preference of the person: it is kept in the
`preferences` store (with `browserPreferences()`, the browser's `localStorage`) under the key `unmarkedNotice`, as `"1"` when on and absent
when off. The words are `strings.unmarkedTitle`, `unmarkedMessage` and `settingsUnmarked`. The .NET SDK calls the
setting `TellUnmarked`.

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
  ...browserChatServices(),
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

Links open through `openLink`; in a web page `browserOpenLink` opens them in a new tab
(`window.open(url, "_blank", "noopener,noreferrer")`). A host that opens links its own way, such as an Office add-in
or a browser extension, passes its own. Screen readers hear that
each link opens in a new tab.

`chat.setAboutOpen(true)`, `chat.about` and `chat.copyAboutDetails()` do from code what About does. For a skin of
your own, `@fadenstack/ui` exports the link helpers: `fadenstackLink`, `footerLink`, `helpLink`, `refSource` and
`majorMinor`.

## Settings

The gear in the header opens the panel's settings: the language, the switch for the [notice about answers without an AI
mark](#an-answer-without-an-ai-mark), and below them what your application adds, such as sign out or its own options,
so they all sit in one place:

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

**Approvals** is the settings' section for what the person allowed for longer than one call: the grants the server
holds ("Working alongside you in report.docx, 30 min left", "Bypass in a chat, 30 min left"), and the tools allowed
always on this device, each with **Revoke**. It is read again whenever the settings open (`chat.grants.load()`).

## Grants, Bypass and the markers

With the same `ApprovalBroker` as the agent's approvals, the panel also draws the cards and the second sign-in of the
server-held grants (see [Server-held grants and Bypass](server-grants.md)); the broker is the agent's grant handler and
step-up handler, so there is no code of your own:

```ts
const approvals = new ApprovalBroker();
const agent = FadenstackAgent.createBuilder().useClient(client).useApprovals(approvals).build();
const chat = new AgentChatViewModel(agent, approvals, browserChatServices());
```

- **The work card** ("Work alongside you?", `session.offerWork(places)`) lists the places, each of which the person
  may take out, the time to pick (15 min, 30 min, 1 h, 2 h; 30 min first), what the agent may do there without asking
  and that it still asks before deleting, sending, paying or publishing. **Not now** comes first. **The extension
  card** ("Keep working alongside you?", `session.offerExtension(...)`) shows only what it adds ("30 min longer").
  A card shows in the chat of its conversation only; one offered before its conversation existed shows in every chat.
- **The marker** of a chat's running stretch of work says "Working alongside you · 23 min left" by the server's clock
  (paused: "· paused"), has **Stop** (every grant of the device, and the running turn) and, two minutes before the
  end, "Another 30 min" (as far as the server allows; it says so when it cannot).
- **The Bypass entry** in the tool-mode menu appears only where the server offers Bypass to this agent. Picking it
  opens the confirmation (`chat.startBypass()` does the same); it never switches on by itself. The card says what
  no longer asks, what still asks, what the server records, how long (15 min, 30 min, 1 h, never longer than the
  server's longest, no extension) and takes an optional reason that administrators see. **Not now** comes first and has
  the focus; Allow ("Switch Bypass on") is never the default, and Enter and Escape do not press it. After the click
  the card waits: the second sign-in opens in a new tab (`approvals.openBrowser` is the hook to change that), the card
  shows its code and "Open the page again", and Bypass is on only when the server confirmed it. If it does not
  come, the card says why -- not approved in the browser, took too long, no browser, refused, offline, the server
  cannot check -- and the chat stays as it was.
- **Bypass on** shows "Bypass on · 12 min left" with what is recorded and Stop; the chat list marks the chats that run
  in Bypass. **When it ends** the chat says why ("Bypass ended: an administrator ended it. Approvals ask again.") with
  **Switch on again**, which opens the confirmation again. Pausing at the app's end is not an end.
- **Focus.** A new card takes the focus, on its **Not now** button. The confirmation's buttons are reachable by Tab
  and pressed with Space; the switch and "Open the page again" ignore Enter.
- A call a longer approval let through reads "Allowed by your longer approval".

Times are said as people say them: `period(chat.strings, ms)` gives "15 min", "2 h", "1 h 30 min", never "120 min".

### The marker for the whole device

A chat's marker is the chat's. For a host that shows a marker outside the chat -- a toolbar chip, a badge on the
avatar, a menu -- `GrantMarkerViewModel` shows every grant of the device over the
[grant lifecycle](server-grants.md#the-grant-lifecycle): the time left of the grant ending first ("3 grants running ·
first ends in 12 min" with several), one line per grant with its chat, **Stop**, "Another 30 min" once near the end
(never for Bypass), and one summary per grant that ended ("Worked alongside you for 23 min", where, how many calls ran
without asking, and why it ended). A summary for a grant that ended while the screen was locked waits until the person
is back.

```ts
const lifecycle = new GrantLifecycle(agent.grants);
const marker = new GrantMarkerViewModel(lifecycle, () => chat.strings, {
  chatTitle: (conversationId) => titles.get(conversationId),
  stopTurn: (conversationId) => chats.get(conversationId)?.stop(),
});
// React: <GrantMarkerView marker={marker} />      Vue: <GrantMarker :marker="marker" />
```

`marker.retext()` after a change of language. What the host feeds the lifecycle is in
[the grant lifecycle](server-grants.md#the-grant-lifecycle).

| View model | What it holds |
|---|---|
| `chat.grants` (`GrantsViewModel`) | The chat's `cards`, `bypassCard`, the markers (`hasMarker`, `markerText`, `isEnding`, `hasBypass`, `bypassText`), the ended line (`hasBypassEnded`, `bypassEndedText`, `canSwitchOnAgain`), `standing` for Settings, and `stop()`, `keepGoing()`, `stopBypass()`, `switchOnAgain()`, `load()`. |
| `GrantPart`, `BypassPart` | A card: `title`, `places`, `durations`, `selectedDuration`, `buttons` (Not now first), `allow()`, `notNow()`, `state`; the Bypass card also `reason`, `isSigningIn`, `signInCodeText`, `openAgain()`, `ignoresKey()` and `initialFocus` (never Allow). |
| `GrantMarkerViewModel` | The device-wide marker: `markerText`, `badgeText`, `entries`, `summaries`, `stop()`, `keepGoing()`. |

## Thinking

The header has a pill beside the tool mode where the person picks how long the agent thinks before it answers: Auto, Off,
Low, Medium or High. A menu lists the levels with what each means; the arrow keys move, Enter or Space picks, and Escape
closes it. The pick is kept for the person and the agent on the device, and a change applies from the next message. A
server can cap the levels with `ui.reasoning.max` in the agent version, and the pill then offers no level above it. The
levels and the cap are described in [How long the agent thinks](agent.md#how-long-the-agent-thinks).

In the view model:

| Member | What it is |
|---|---|
| `reasoningOptions` | The levels the agent offers, each a `ReasoningOption` with `level`, `label`, `description` and `selected`. Empty until the agent has started. |
| `reasoningLevel`, `selectedReasoning` | The level new messages think at, and its option. |
| `reasoningPillText`, `reasoningAutomationName`, `reasoningToolTip`, `reasoningHint` | The pill's words: the bare level ("Low"), the full name for screen readers ("Thinking: Low"), the tooltip, and the line saying what the level means. |
| `isReasoningMenuOpen`, `setReasoningMenuOpen(open)` | Whether the menu is open. The state sits in the view model, so a skin needs none of its own. |
| `selectReasoning(level)` | Takes the person's pick and closes the menu. A level the agent does not offer changes nothing. |

## Limiting running turns

A host that runs several chats, and wants to limit how many turns work at the same time, passes a `turnGate`. The panel
awaits it when a turn is about to start: the person's message is already shown, and nothing has been sent yet.

```ts
const chat = new AgentChatViewModel(agent, approvals, {
  ...browserChatServices(),
  turnGate: async (signal) => {
    await slots.acquire(signal);      // your own limit: resolves when a slot is free
    return () => slots.release();     // or { dispose() { ... } }
  },
});
```

The gate returns a lease, a function or an object with `dispose()` (`TurnLease`), that the panel releases once when the
turn ends, however it ends. While the gate waits, `chat.isWaitingForSlot` is true and the turn shows the line
`strings.waitingForSlot` ("Waiting for a free slot"). Stop aborts the `signal`: the turn is stopped and nothing is sent.
A gate that throws fails the turn with its message. A lease that throws when released is ignored. Without a gate, turns
start at once. The gate applies to messages, not to host commands. The .NET SDK has the same option, `TurnGate`.

## View models for other frameworks

Each view model is observable: `subscribe(listener)` calls the listener after each change and returns the unsubscribe,
and `version` grows with every change. Collections are replaced, never changed in place, so a skin compares them by
reference. Each turn and each part is its own view model, so one change re-renders one view.

| View model | What it holds |
|---|---|
| `AgentChatViewModel` | The chat: `turns`, `input`, `attachments`, `sessions`, `toolModes`, `toolMode`, `greeting`, `suggestions`, `isBusy`, `isWaitingForSlot`, `signInRequired`, `error`, `strings`, `about`, `footerLink`, `showUnmarkedNotice`, the thinking members above, and the actions `send`, `stop`, `newChat`, `openSession`, `loadEarlier`, `selectToolMode`, `selectReasoning`, `setShowUnmarkedNotice`, `invokeTool`, `setAboutOpen`, `openLink`. |
| `TurnViewModel` | One exchange: `userText`, `parts`, `state`, `outcome`, `usageText`, `durationText`, and `copy`, `edit`, `retry`. |
| `ResponsePart` | One part of an answer, with a `kind`: `markdown`, `reasoning`, `tool`, `approval`, `notice`, `citations`, and `card`, `table`, `progress` and `diff` for modules. |
| `AttachmentViewModel` | One context chip. |

A turn's `state` is `running`, `waiting_for_approval`, `completed`, `blocked`, `stopped` or `failed`.

A new skin draws the classes of `@fadenstack/ui-web/styles.css` and takes the rest from `@fadenstack/ui-web`:
`iconPaths` for the icons, `agentAvatar()` for the avatar as SVG data, `stickToBottom`, `dismissOnOutside`,
`fitToContent` and `composerKey` for the behaviours, and `toolBadges`, `toolStatusIcon`, `noticeIcon` and the others
for how parts look. The React and Vue skins are the examples.

## Host commands

History and other explicit command buttons.

Use `chat.invokeTool(name, arguments, { origin: "user_history" })` for a concrete
user action. It shares busy state, approval cards and `chat.stop()` with chat,
preserving the composer's draft, skills and attachments. The optional
`label` option gives the command a human-readable transcript title, such as
`"Undo file change"`. It must be a nonempty single line of at most 200 characters;
it changes display metadata only, never the tool name, arguments or policy checks.
The optional
`beforeCommand(command, signal)` / `afterCommand(command)` hooks let the host
check native context and release its lifecycle state. Message hooks are separate;
commands never resolve or send the next message's attachments. Host guards must
respect the cancellation signal.

The method returns the command receipt when available. Preparation errors appear
in `chat.error`; errors and Stop after a turn starts appear on that command turn.
An already busy or uninitialized chat returns `undefined`. Command turns cannot
be edited/retried as prompts, including after reopening history. The Vue and
React skins respect this distinction. See [Host commands and central policy](host-commands.md)
for central compatibility and the host's native execution responsibilities.

