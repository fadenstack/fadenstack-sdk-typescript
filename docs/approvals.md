# Approvals

This page is for app developers: what asks the person, what no level skips, and what survives a restart. [Tools and approvals](tools.md#approvals) has the details of the handler and the decision order, and [Server-held grants and Bypass](server-grants.md) has the grants.

It follows OWASP ASVS 5.0 chapter V8 (authorization is decided in a trusted layer, not by the model) and OWASP Top 10 for LLM Applications 2025, LLM06 (excessive agency: a person approves high-impact actions).

## The levels

The person picks a level for each conversation (`session.toolMode`). The level decides, per tool class, whether a call runs, asks or is hidden. [Tools and approvals](tools.md#tool-modes) has the rest.

| Level | Read | Write | Destructive and unclassified | What it is |
|---|---|---|---|---|
| Read only (`"read_only"`) | runs | hidden | hidden | The model can look, not change. |
| Ask (`"ask"`) | runs | asks | asks | The default; every session starts here. |
| Auto (`"auto"`) | runs | runs | asks | Changes run; the risky ones still ask. |
| Bypass (`"bypass"`) | runs | runs | runs where the gateway covers the call | The server's grant for one conversation, after a second sign-in. |

Below Auto, a call to an open-world tool asks too. A chat set to `"bypass"` without its server grant runs in `"auto"` (`session.effectiveToolMode` says which).

## Standing approvals

A standing approval spares a question the level would ask. The request offers only the ones that apply (`ApprovalRequest.canAllowForSession`, `canAllowAlways`).

| Kind | Covers | Held |
|---|---|---|
| Once (`ApprovalDecision.approve()`) | This call. | Nowhere. |
| For this chat (`approveForSession()`) | One tool, this conversation. | The session object's memory; a chat opened again asks again. |
| Always (`approveAlways()`) | One tool, on this device. | An `ApprovalStore`: `IndexedDbApprovalStore` in a browser, sealed under the person's non-extractable WebCrypto key since standalone.8 (AES-GCM, which authenticates each record and binds it to the database, the agent and the tool; the .NET SDK seals with an HMAC-SHA256 for the same purpose). Each record keeps the tool's source and server, so a new MCP server bringing a tool of the same name inherits no "always". A record that fails to open answers nothing and the person is asked again. |
| For a time (`ApprovalDecision.approveFor(duration)`) | One tool, a chosen time. | A server grant. |
| For a stretch of work (`session.offerWork(places, reason)`) | Named places and classes, for a time. | A server grant. |

A server grant is read from the server for each covered call and once more as the call goes out (standalone.9), so a grant that ended meanwhile runs nothing. A time or work grant never covers a call on the never-skip list below, nor a destructive or unclassified one.

## The never-skip list

These ask, or are refused, at every level, Bypass included. Bypass skips questions, never rules. The list is in code as `ApprovalFloor` (`ApprovalFloor.neverSkipped`, in this order, exported from `@fadenstack/agents`) and is tested at ask, auto and bypass.

| Id | What | Where it is decided |
|---|---|---|
| `refused` | Deny rules, and hidden or refused tools. | The call does not run and nobody is asked; the turn's outcome is `tool_denied`. |
| `ask_first_rule` | An administrator's "Ask first" rule. | The gateway marks the call `rule: true`; `ApprovalRequest.requiredByRule` is set. The person's "for this chat" or "always" does not answer it. |
| `author_always` | The author's `approval: always` in the tool contract. | Asks every time, like a rule. (`never` and `ask` are not on the list: `ask` can be answered by the person's "for this chat" or "always".) |
| `physical` | A tool that acts in the physical world. | See the note below. |
| `open_world_tainted` | An open-world tool in a turn that read untrusted content. | See the note below. |
| `mcp_server_question` | A question an MCP server asks the person itself (elicitation). | This SDK's MCP client declares no elicitation, so a server cannot ask, and nothing answers for the person. A question would have to go to the person. |
| `gateway_held` | A call the gateway holds for the person (a gateway tool's approval). | The person is asked and the SDK sends their answer. Bypass never answers the gateway: only the server may skip its own question. |

**Not marked yet.** Neither the SDK nor the gateway has a marker for `physical` and `open_world_tainted` (`ApprovalFloor.notMarkedYet`; desktop 16 F-10, intent IM-09). Until they do, a tool of that kind needs `approval: always` in its contract or an administrator's "Ask first" rule to be held to the floor.

**Destructive and unclassified calls** (`destructive_or_unclassified`, `ApprovalFloor.destructiveOrUnclassified`; not on the list) ask at every level except Bypass. Bypass covers them only where the tenant allows it, after the second sign-in ([Bypass](server-grants.md#bypass)), and only the calls the gateway says the conversation's grant covers; the rest still ask.

## The arguments of a call the gateway holds

From core 0.7.1 (rc22) the event of a call the gateway holds for the person carries the call's `arguments` text (cut at 8000 characters), `argumentsTruncated` when it was cut, and `argumentsSha256`. The SDK fills `ApprovalRequest.arguments` from it, so the card shows them as it does for the app's own calls: when the text is a complete JSON object, its members; when it was cut or is not a JSON object, the text as one read-only value under the note "The arguments are shortened." (`ApprovalRequest.argumentsShortened`, `ApprovalPart.argumentsNote`; five languages). The card never shows more than its usual preview. An older gateway sends none, and the card shows no arguments, as before. The record of tool calls takes the hash from the same event. .NET: `ApprovalRequest.Arguments`, `ArgumentsShortened`, `ApprovalPart.ArgumentsNote`.

## After a restart

Neither SDK stores a pending approval card. When the page closes or reloads, or Chrome stops an extension's service worker, the turn ends and the person asks again. What survives a restart is "Allow always", sealed as above. A Bypass grant is the server's; `agent.grants.pauseBypass()` and `resumeBypass()` carry it across a restart ([Bypass](server-grants.md#bypass)).

## The person's reason

A person who declines can say why ("Say why"). Pass it as `ApprovalDecision.deny(reason)`. The SDK cleans it with `cleanReason` (control characters and invisible marks out, trimmed) and cuts it to 500 characters (`MAX_REASON_CHARS`). The cleaned text reaches the model's next turn as part of the tool result and is kept in the transcript's `approval.decision` entry as `reason`. It is the person's own text, so it is not fenced like untrusted data.

## Delegation

This SDK has no delegation between agents on a device, so there is no "for this task" answer to protect. In the .NET SDK a call the other agent asks about every time (`DelegationApprovalRequest.AsksEveryTime`) is never answered from "for this task" ([Parity](parity.md)).
