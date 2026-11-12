# Host commands and central policy

This page covers host tools the person starts themselves (a button, a view of a module), and the server's fresh policy check around every host tool call, whoever started it. Both go through `POST /v1/agents/{agent}/tools/check`.

The [.NET SDK](../dotnet/host-commands.md) has the same two features on the same wire, so an app behaves the same in either.

## A host tool the person starts

A host command is a host tool called without a model: the person pressed "Undo", opened a record, restored a version. It still goes through the agent's policy, the approval cards and the transcript, so it is as governed as a call the model asks for.

```ts
const result = await session.invokeTool(
  "restore_record",
  { action_id: "a-42" },
  { origin: "user_history", label: "Undo file change" },
);

if (result.outcome === "ok") {
  showDone(result.result);
}
```

`invokeTool(name, args, options)` waits for the command to end and returns a `HostCommandResult`: the `turnId`, the `callId`, the `outcome` (`ok`, `error` or `denied`) and the `result` text. `streamTool` streams the same events a turn has (`turn_started`, `tool_started`, `approval_requested`, `approval_decided`, `tool_completed`, `turn_completed`). Leaving the stream early, or aborting the `signal` in the options, also cancels a pending approval. A stopped command throws the signal's reason, as a stopped turn does; `isAbortError` tells it apart.

The options are `origin` (`user_command`, the default, or `user_history`), `label` and `signal`.

What happens, in order:

1. The SDK checks the name (letters, digits, `_` and `-`, at most 64) and the label, and copies the arguments as strict JSON: plain objects, arrays, strings, finite numbers, booleans and null. What the person reviews is what runs, whatever the caller does with its own object afterwards. A name, label or value that does not qualify throws a `TypeError` before anything is sent.
2. A command is available for the agent's host tools only. A tool from a source such as MCP makes the command throw. A name the agent does not have ends the command with the outcome `error`.
3. The arguments are checked against the tool's parameter schema (required ones present, none unknown where the schema forbids it, the stated types and enums); a mistake ends the command with the outcome `error`, before the server is asked.
4. The server checks the command (phase `prepare`). It answers `deny`, `ask` or `run`, the class and the tool mode it applies, and whether an administrator's rule asks.
5. The SDK applies the stricter of the tool's class and the server's, and the narrower of the session's mode and the server's. A tool the mode hides, or a `deny`, ends the command with the outcome `denied` and the server's message, and a notice on the turn.
6. Where the server or the mode says `ask`, the approval handler is asked, always for this call alone. The request offers no "for this chat", no "always" and no time grant, and a standing approval or a grant never covers it.
7. Immediately before the tool runs, the server checks it again (phase `dispatch`). The answer must carry the same profile, arguments and decision stamps, the same principal, and not be a denial. Anything else stops the command with the outcome `error`.
8. The tool runs, and the result is the command's outcome.

No model request is made at any point. A server too old to have the route answers 404, and the command ends with the outcome `error`: it never runs unchecked.

!!! note "Stamps are not permits"
    The stamps are comparison values. They show that nothing changed between the two checks; they are not signed permission, a credential, or proof that the tool's effect happened. Your tool still checks its own access, scope and conflicts. Do not retry a mutation automatically after an uncertain outcome.

A tool stage that changes the arguments of a command stops it: the SDK does not send locally changed values (for example PII unmasked on the device) to the check endpoint, and there is no reviewed disclosure contract for that combination yet. A command ignores a tool's `scope`: it is not a call the model made, so there is nothing to switch on.

### The label

The label is the text the chat shows for the command. It is one line, not blank, at most 200 characters, with no control characters; otherwise `invokeTool` throws a `TypeError` before anything is checked or run. It is trimmed and kept in the transcript. It is never an argument, a grant or a message to the model.

Without a label the chat shows the tool's name.

### The transcript and the model

A command writes a `user.command` entry (`EntryTypes.userCommand`) with the tool's name, its origin (`user_command` or `user_history`) and the label, never the arguments. The tool's start and end entries and the approval decision follow, as for a model's call.

The turn of a command is left out of the model's history. Its result would otherwise reach the model without a prompt and leave tool messages without a call. Modules cannot write `user.command` entries: it is one of the SDK's own types.

A session runs one turn at a time. Starting a command while a turn or another command runs throws.

### In the chat panel

`AgentChatViewModel.invokeTool` does the same in the chat panel: the command is shown as a turn titled with its label, the approval card appears as for any call, and the composer's draft, skills and attachments are left alone.

```ts
const result = await chat.invokeTool(
  "restore_record",
  { action_id: "a-42" },
  { origin: "user_history", label: "Undo file change" },
);
```

- The `beforeCommand(command, signal)` option runs first, with the command's `name`, `origin` and `label` (not its arguments): check that the document is in a state the tool may act on. When it throws, nothing is started and `chat.error` says why.
- The `afterCommand(command)` option runs once afterwards, however the command ended, also when it was stopped or its preparation failed.
- The chat is busy while the command runs; Stop (`chat.stop()`) cancels it. The method returns `undefined` when the chat is busy or has not started, and otherwise the `HostCommandResult`, or `undefined` if the command did not get to a result.
- The arguments are copied before `beforeCommand` runs.
- A command turn can be neither edited nor tried again as text, also after the session is opened again. Both skins respect this.

## Fresh policy for the model's host calls

A server that lists `host_tools.dispatch_check` in the agent profile's features (`HOST_TOOL_DISPATCH_FEATURE` in `@fadenstack/client`) checks every host tool call the model makes, too. The agent uses the check automatically once it has seen the feature. An older server keeps the previous behaviour.

For each host call the model asks for, the SDK:

1. Reads the profile again and checks that the agent's identity and published contract are unchanged.
2. Checks the call with origin `model_tool` and the model's call id (phase `prepare`), against the pinned schema. The server's class and mode can only make the call stricter than the tool declared; its denial ends the call.
3. Asks the person through the normal approval handler where the server, the mode or an administrator's rule says so. An administrator's rule asks for this call alone.
4. Right before the tool runs, reads the profile again, compares the approval limits, and checks the call again (phase `dispatch`) with the three stamps of the first answer. A denial, a different stamp or principal, changed approval limits or a changed level stops the call.

The call's result for the model is then an error, and the tool did not run. Network errors and malformed answers never let a call fall back to the old path.

The arguments that reach the tool must be the ones the person reviewed. If a stage (for example local PII unmasking) changed them, the call is stopped: the SDK does not send locally unmasked values to the check endpoint.

### Requiring the check

```ts
const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(...nativeTools)
  .requireHostToolPolicyChecks()
  .useApprovals(approvals)
  .build();
```

With `requireHostToolPolicyChecks()` the agent refuses to start against a server that does not advertise `host_tools.dispatch_check` (`start()` and the first session throw a `FadenstackError`: "The gateway does not advertise support"), and never uses cached policy. `agent.hostToolPolicyChecks` says whether the check is in use.

Without it, the check is used as soon as the server has offered it. From then on, **losing it fails closed**: if a later profile no longer lists the feature, the agent throws that error when it reads the profile, and host calls do not go back to the old behaviour. Build a new agent.

The page [Central policy before native host execution](host-policy.md) says the same from the point of view of a native host.

## What the SDK sends

`client.agent.checkHostTool(check)` is the wire call, for hosts that build their own flow.

| Field | Meaning |
|---|---|
| `name`, `arguments` | The tool and its JSON arguments. |
| `toolMode` | The session's level. The server checks Bypass as Auto. |
| `origin` | `user_command`, `user_history` or `model_tool`. |
| `callId` | Required for `model_tool`: it binds the audit record across the two phases. |
| `phase` | `prepare` before the person is asked, `dispatch` right before the tool runs. |
| `schemaSha256` | SHA-256 of the tool's parameter schema (canonical JSON: sorted keys, no spaces), as 64 hexadecimal digits. |
| `prepared` | For `dispatch`: the `prepare` answer, whose three stamps are sent back. |
| `conversationId`, `turnId` | The session and the turn. They go in the headers `x-faden-conversation-id` and `x-faden-turn-id`, not in the body. |

The answer is a `HostToolDecision`: `decision` (`deny`, `ask` or `run`), `toolClass`, `effectiveToolMode`, `requiredByRule`, `message`, the three stamps (`profileStamp`, `argumentsStamp`, `decisionStamp`) and the `principal`. An answer with a decision, class or mode the SDK does not know, a stamp that is not 64 hexadecimal digits, or no principal, throws a `FadenstackError` ("did not return a valid host-command policy decision"). The .NET SDK treats an unknown decision as a denial; the TypeScript SDK refuses the answer.

## What it is not

- It is not a way to call gateway tools or MCP tools: the check is for host tools only.
- It is not an atomic lock with the administrator's console. Normal server cache boundaries still apply between the second check and the tool's run.
- It does not replace the native checks of your own tool (access, scope, conflicts).
