# @fadenstack/ui-web

The web look of the [Fadenstack](https://fadenstack.com) chat, for any framework: the stylesheet, the icons, the
agent's avatar, the panel's browser behaviours, and the browser's ways for what the chat asks of its host. [`@fadenstack/ui-react`](https://www.npmjs.com/package/@fadenstack/ui-react)
and [`@fadenstack/ui-vue`](https://www.npmjs.com/package/@fadenstack/ui-vue) draw the same markup with it; a skin for
another framework uses it the same way.

```bash
npm install @fadenstack/ui-web
```

```ts
import "@fadenstack/ui-web/styles.css";
```

- `styles.css`: the panel's classes (`.fdn-*`), themed with CSS variables (`--fdn-accent`, ...). It follows the
  page's light or dark scheme, and its directions are logical, so it mirrors for a right-to-left language.
- `iconPaths`: the icons as SVG path data on a 24 x 24 grid.
- `agentAvatar()`: the agent's avatar as SVG data, which a skin turns into its own elements.
- `stickToBottom`, `dismissOnOutside`, `fitToContent`, `focusAtEnd`, `composerKey`: the panel's behaviours.
- `toolBadges`, `toolStatusIcon`, `noticeIcon`, ...: how parts look, decided once for every skin.
- `browserChatServices()`: the four things the chat view model needs from its host, the browser's way:
  `browserClipboard`, `browserOpenLink` (a new tab, `noopener,noreferrer`), `browserSaveFile` (a download) and
  `browserPreferences()` (`localStorage`). Pass them, or your own over them:
  `new AgentChatViewModel(agent, approvals, { ...browserChatServices(), prompts: browserPromptStore() })`.
- `browserPromptStore()`: the user's saved prompts in `localStorage`.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/chat-panel/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
