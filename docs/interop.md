# Interop

How a Fadenstack agent talks to the rest of the ecosystem: AG-UI-shaped events for AG-UI clients, hooks that watch (and can tighten) model calls and tool calls, and opt-in OpenTelemetry.

## AG-UI events

[AG-UI](https://docs.ag-ui.com) is the open protocol agent front ends speak. The SDK's own view models keep using the native `AgentEvent`s; `agUiEvents` is an adapter over that stream, so a third-party AG-UI client (CopilotKit, assistant-ui with its AG-UI adapter) can render a Fadenstack agent. The event types are the SDK's own and follow AG-UI 1.0.4; the package has no runtime dependency on `@ag-ui/*`. The test suite checks the shapes against `@ag-ui/core` 1.0.4 and the streams against `@ag-ui/client` 1.0.4 (`HttpAgent`), which accepted all five golden streams (text with reasoning, tool call, approval interrupt and resume, notices, run error).

```ts
import { agUiEvents, agUiJson } from "@fadenstack/agents";

const session = await agent.startSession();
for await (const event of agUiEvents(session.stream("Delete page 8"), { threadId: session.id })) {
  response.write(`data: ${agUiJson(event)}\n\n`); // one AG-UI event per SSE message
}
```

`agUiJson(event)` is the event's JSON: compact, `type` first (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, ...), camelCase keys, `metadata` last. A run that stops on an approval looks like this:

```json
{"type":"RUN_STARTED","timestamp":1700000000000,"threadId":"thread-1","runId":"turn-1","metadata":{"toolMode":"ask"}}
{"type":"TOOL_CALL_START","timestamp":1700000000001,"toolCallId":"call-2","toolCallName":"delete_page","metadata":{"toolClass":"destructive","source":"host"}}
{"type":"TOOL_CALL_ARGS","timestamp":1700000000002,"toolCallId":"call-2","delta":"{\"page\":8}"}
{"type":"TOOL_CALL_END","timestamp":1700000000003,"toolCallId":"call-2"}
{"type":"RUN_FINISHED","timestamp":1700000000004,"threadId":"thread-1","runId":"turn-1","outcome":{"type":"interrupt","interrupts":[{"id":"call-2","reason":"approval_required","message":"Deleting cannot be undone.","toolCallId":"call-2","metadata":{"toolName":"delete_page","toolClass":"destructive","source":"host"}}]}}
```

### The mapping

| Fadenstack event | AG-UI event |
|---|---|
| a turn starts | `RUN_STARTED` (`threadId`, `runId`; `metadata.toolMode`) |
| a turn completes | `RUN_FINISHED`, outcome `success`; `result.outcome` says how the turn ended (`completed`, `prompt_blocked`, `response_blocked`, `tool_denied`, `rate_limited`); `usage` has the token counts when the model reported them |
| the stream fails (a stopped turn) | `RUN_ERROR` (`message`); a cancellation is thrown on instead |
| a text delta | `TEXT_MESSAGE_START` (once), `TEXT_MESSAGE_CONTENT` per delta, `TEXT_MESSAGE_END` when anything else comes |
| a reasoning delta | `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT` per delta, `REASONING_MESSAGE_END`, `REASONING_END` |
| a tool call starts | `TOOL_CALL_START` (`metadata.toolClass`, `metadata.source`), `TOOL_CALL_ARGS` (the arguments as one JSON text), `TOOL_CALL_END` |
| a tool call ends | `TOOL_CALL_RESULT` (`content` is the result text; `metadata.outcome` is `ok`, `error`, `denied` or `cancelled`, `metadata.durationMs`) |
| a call waits for the user (the approval card) | `RUN_FINISHED` with outcome `interrupt`: one interrupt, `id` and `toolCallId` are the call's id, `reason` is `approval_required`, `message` is the reason the card shows |
| the user answers | the next event opens a new run on the same thread: `RUN_STARTED` with `runId` `{turnId}.2` and `metadata.resumes` (`interruptId`, `approved`); a denied call ends with a `TOOL_CALL_RESULT` whose `metadata.outcome` is `denied` |
| a governance notice (a refusal, a limit) | `CUSTOM` `faden.notice` |
| citations, a PII notice, a left-out attachment, the provenance mark (gateway words) | `CUSTOM` `faden.citations`, `faden.pii`, `faden.attachment_left_out`, `faden.provenance`, with the gateway's value |

Details that matter to a client:

- **Interrupt.** AG-UI 1.0 models a pause as a `RUN_FINISHED` event with an `interrupt` outcome, and the answer as a new run. The adapter follows it, so an off-the-shelf client shows the approval as an interrupt, and the events after the answer belong to the run `{turnId}.2`. The native stream itself keeps going in one turn; only the AG-UI view splits it.
- **Session state.** The SDK has no session state to send, so `STATE_SNAPSHOT` and `STATE_DELTA` are not produced.
- **Not sent.** The gateway round (the history the SDK keeps for the next request), the pictures a tool returns, and any header or secret. Tool arguments and results go as the native events carry them.
- **Ids.** `messageId` is `{turnId}-m1`, `{turnId}-m2`, ... for text and reasoning, and `{turnId}-result-{callId}` for a tool result. `threadId` is the one you pass, else the first turn's id. `timestamp` is milliseconds since the Unix epoch.
- **Same JSON from both SDKs.** The .NET and TypeScript adapters write the same bytes for the same events; golden files in both repositories' tests (text, tool call, approval interrupt, error, notice) hold them.

## Hooks

Hooks are the app's own code that runs before and after each model call and each tool call. Use them to audit, to keep your own log, to annotate a call, or to make a tool call stricter than the policy made it. They are documented and stable; they build on `addChatStage` and `addToolStage`. The .NET SDK has the same hooks (`IAgentHooks`, `AgentHooks`, `AddHooks`) with the same semantics.

```ts
import { FadenstackAgent, toolHook, type AgentHooks } from "@fadenstack/agents";

const audit: AgentHooks = {
  beforeToolCall(call) {
    // Our own tool "export_report" is always shown to the person, even where the policy would run it.
    if (call.source === "host" && call.toolName === "export_report") {
      return toolHook.ask("Exports leave the building.", { audit: "export asked" });
    }
  },
  afterToolCall(result) {
    console.log(`${result.toolName} ${result.outcome} in ${result.durationMs} ms`);
  },
};

const agent = FadenstackAgent.createBuilder()
  // ...
  .addHooks(audit, 0)
  .build();
```

Every method is optional and may be async. A `beforeToolCall` that returns nothing goes on as the policy decided.

### The four points

| Point | Method | What the hook sees |
|---|---|---|
| Before a model call | `beforeModelCall(context, signal)` | `agentName`, `sessionId`, `turnId`, `round`, `model`, `messageCount`, `toolCount`. |
| After a model call | `afterModelCall(result, signal)` | The same ids, `outcome` (`ok`, `error`, `denied`, `cancelled`), `durationMs`, `inputTokens` and `outputTokens` when the model said, `toolCallCount`. |
| Before a tool call | `beforeToolCall(context, signal)` | `toolName`, `source` (`host`, `mcp`, `gateway`, `skills`, ...), `server`, `toolClass`, `callId`, `arguments` (a frozen copy), and `decision`: what the policy decided (`runs`, `asks`, `refused`). It may return a verdict. |
| After a tool call | `afterToolCall(result, signal)` | The same, plus `outcome` (`ok`, `error`, `denied`, `cancelled`), `durationMs` (without the time the person took to answer a card) and `resultText` for the app's own (`host`) tools only. |

A model hook sees no prompt and no answer text. If your app wants to be able to show them, offer it once with `builder.useHookContent()`: `messages` and `text` are then filled, but only while [content logging](#content-logging) is on. They are `undefined` otherwise, and always `undefined` after a restart until the person switches it on again.

## Content logging

Prompts, answers, tool arguments and tool results are the person's data. The rule (ASVS 5.0 V16, security logging): content is **off by default**, switching it on is **the person's choice**, it **ends at a set time**, and it is **visible while it is on**.

- **`useHookContent()` offers, it does not switch on.** The model hooks see message and answer text only while `agent.contentLogging.isOn`. **Behaviour change:** before, `useHookContent()` filled them for good. (.NET also has `EnableSensitiveData` for its OpenTelemetry chat client, which follows the same switch; this SDK has no OpenTelemetry chat client.)
- **The person switches it on for a time.** `agent.startContentLogging(ms)` takes 15 minutes to 24 hours (the UI offers 1 hour, 4 hours and 24 hours, 1 hour first); `agent.stopContentLogging()` ends it at once. It ends by itself at `contentLogging.until` (milliseconds since 1970): a timer ends it, and every check also compares the clock, so a machine that slept cannot overrun it. It is not kept across restarts: a new agent starts with it off. `contentLogging.onChanged(listener)` is called when it goes on or off, also when it ends by itself.
- **It can be refused.** `startContentLogging` throws `ContentLoggingError` (`reason`: `"notOffered"` or `"forbiddenByPolicy"`) when the app did not offer content logging, or the [machine policy](machine-policy.md) says `contentLogging: "forbidden"`. `contentLogging.canStart` says whether it can be started, so an app shows its control only then. A time outside the bounds throws a `RangeError`.
- **A development setup calls `startContentLogging` itself**, for example right after `build()`.
- **Each start and stop is logged** (event ids 2083 and 2084, level `information`) with the time it was set to end, and with no content. It is only a local log entry: core has no client event for it, so nothing is sent to a server.
- **What the person sees.** While it is on, the chat shows a band: "Content logging is on until 14:30. Prompts and answers are written to the app's logs." with *Stop* (`chat.contentLogging`, `ContentLoggingBand` in `@fadenstack/ui-react` and `@fadenstack/ui-vue`, inside `ChatPanel`; the time is in the person's locale, with the date when it ends on another day). Apps put `ContentLoggingSettingsViewModel` (`@fadenstack/ui`, with `ContentLoggingSettings` in both skins) in their settings: a choice of 1 hour, 4 hours or 24 hours, *Start* and *Stop*, the end time while it is on, and a sentence saying what is logged and that it ends by itself. It shows only when the app offers content logging and the policy allows it. Texts are in the five built-in languages. .NET: `ContentLoggingState` (`agent.ContentLogging`), `StartContentLogging`, `StopContentLogging`.

A tool call that the policy refused (the tool mode hides it, the gateway or the server's check denies it) is still shown to the hooks with `decision: "refused"`, so they can audit it, and their answer is dropped. A tool the model made up, a call with invalid arguments and a person's own host command are not hooked.

### The rule that keeps the floor

`beforeToolCall` runs **after** the policy decided (OWASP ASVS 5.0 V8: authorization is enforced in a trusted layer, and app code cannot widen it). Its answer can only be:

- `toolHook.continue()` (or nothing): go on as the policy decided.
- `toolHook.ask(reason)`: ask the person. A call the policy would run unasked then shows the approval card, once only: no earlier "allow always", no grant answers it. A call the policy already asks about is asked as before.
- `toolHook.deny(reason)`: refuse. The reason is cut to 500 characters and reaches the model as a declined call (`'name' was declined by the app (reason).`). The turn ends as `tool_denied`.

There is no answer that approves a call the policy would ask about or refuse. The type of a verdict has three actions, and the SDK reads only `ask` and `deny` as changes; any other value (`{ action: "approve" }` from untyped code, for instance) counts as "go on". The context a hook gets is frozen, so a hook cannot lower or change a tool's class or the policy's decision. A destructive or unclassified call still shows its card after any hook; a hook that throws counts as "go on". The tests in `hooks.test.ts` pin each of these.

### Notes

A verdict can carry short notes: `toolHook.continue({ ticket: "T-42" })`. They are kept in the `notes` field of the call's `tool.execution_complete` entry in the transcript, on the device, and never sent to the server. A call keeps at most 8 notes (all hooks together); a key is cut to 64 characters and a value to 200.

### Order

Before-hooks run in ascending `order`, then in the order they were added. After-hooks run in the reverse order. The first hook that denies ends the line: later before-hooks are not asked (they still get their after-call).

### A hook that throws

A hook that throws, or rejects, never breaks the run. The SDK logs warning 2060 with the hook's name and the error's type, never the message or any content (ASVS 5.0 V16), and treats the hook as having said "go on as the policy decided".

## OpenTelemetry

OpenTelemetry comes to the TypeScript SDK later. The .NET SDK has it now as an opt-in (`UseOpenTelemetry`): see its `docs/interop.md`.
