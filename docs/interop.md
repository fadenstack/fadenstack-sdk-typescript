# Interop

This page covers how the agent plugs into the app and its tooling: hooks that watch (and can tighten) model calls and tool calls, and OpenTelemetry.

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

A model hook sees no prompt and no answer text. If your app needs them, say so once with `builder.useHookContent()`: `messages` and `text` are then filled. They are `undefined` otherwise.

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
