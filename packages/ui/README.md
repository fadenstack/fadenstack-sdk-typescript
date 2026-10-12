# @fadenstack/ui

View models for a chat with a [Fadenstack](https://fadenstack.com) agent, with no UI framework: the conversation,
streamed Markdown, tool calls, approval cards, notices and the session history. Each view model is observable, so
any framework can render it. [`@fadenstack/ui-react`](https://www.npmjs.com/package/@fadenstack/ui-react) is the
React skin.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/ui
```

```ts
import { FadenAgent } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker } from "@fadenstack/ui";

const approvals = new ApprovalBroker(); // approval cards in the chat decide
const agent = FadenAgent.createBuilder().useClient(client).useApprovals(approvals).build();

const chat = new AgentChatViewModel(agent, approvals);
const unsubscribe = chat.subscribe(() => render(chat)); // after each change
await chat.initialize();
```

The package is an ES module with type declarations, for browsers (Chrome 116 or later) and Node.js 20.19 or
later. It uses [marked](https://www.npmjs.com/package/marked) for Markdown.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/chat-panel/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
- Licence: Apache-2.0 (LICENSE and NOTICE are in the package)
