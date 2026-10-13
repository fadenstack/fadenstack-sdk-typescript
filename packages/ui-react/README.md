# @fadenstack/ui-react

A chat panel for [Fadenstack](https://fadenstack.com) agents in React: the React skin for the view models of
[`@fadenstack/ui`](https://www.npmjs.com/package/@fadenstack/ui). It follows the page's light or dark scheme, is themed with
CSS variables and speaks the chat's language. [`@fadenstack/ui-vue`](https://www.npmjs.com/package/@fadenstack/ui-vue) is the same panel in Vue.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/ui @fadenstack/ui-web @fadenstack/ui-react
```

```tsx
import { createRoot } from "react-dom/client";
import { FadenstackAgent } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import "@fadenstack/ui-web/styles.css"; // the stylesheet every web skin shares

const approvals = new ApprovalBroker();
const agent = FadenstackAgent.createBuilder().useClient(client).useApprovals(approvals).build();

// The user picks the language in the panel's settings; it starts in the browser's.
const chat = new AgentChatViewModel(agent, approvals, { automaticLanguage: navigator.languages, locale: navigator.language });
await chat.initialize();
createRoot(document.getElementById("chat")!).render(<ChatPanel chat={chat} />);
```

React and React DOM 18.2 or later are peer dependencies. The package is an ES module with type declarations.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/chat-panel/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
