# @fadenstack/ui-vue

A chat panel for [Fadenstack](https://fadenstack.com) agents in Vue: the Vue skin for the view models of
[`@fadenstack/ui`](https://www.npmjs.com/package/@fadenstack/ui). It draws the same markup as
[`@fadenstack/ui-react`](https://www.npmjs.com/package/@fadenstack/ui-react) with the same stylesheet, follows the
page's light or dark scheme, is themed with CSS variables and speaks the chat's language.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/ui @fadenstack/ui-web @fadenstack/ui-vue
```

```ts
import { createApp, h, markRaw } from "vue";
import { FadenstackAgent } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, stringsFor } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-vue";
import "@fadenstack/ui-web/styles.css";

const approvals = new ApprovalBroker();
const agent = FadenstackAgent.createBuilder().useClient(client).useApprovals(approvals).build();

// The view model stays raw: Vue never wraps it in a proxy (keep it out of ref() and reactive()).
const chat = markRaw(new AgentChatViewModel(agent, approvals, { locale: navigator.language, strings: stringsFor() }));
await chat.initialize();
createApp({ render: () => h(ChatPanel, { chat }) }).mount("#chat");
```

In a template, the host's own controls go into slots:

```vue
<ChatPanel :chat="chat" :part-renderers="renderers">
  <template #header-extra><AccountMenu /></template>
  <template #context-bar><OpenFile /></template>
  <template #composer-accessory><SummariseButton /></template>
  <template #sign-in><SignIn /></template>
</ChatPanel>
```

Vue 3.5 or later is a peer dependency. The package is an ES module with type declarations.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/chat-panel/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
