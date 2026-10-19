# Outcomes and errors

A turn ends with a typed outcome, refusals included; only real failures throw.

When the server refuses a prompt, stops an answer, or a tool is not allowed, the turn still ends normally: its outcome
says what happened, and its notices say what to tell the user. The session goes on, and the user can send the next
message. See [Outcomes](../../concepts/outcomes.md) for why refusals are outcomes.

## The result of a turn

`session.send` returns an `AgentResult`, and `session.stream` yields it in the `turn_completed` event:

| Field | What it is |
|---|---|
| `turnId` | The turn's id. |
| `outcome` | How the turn ended. See below. |
| `text` | The answer's text. For an answer the server stopped, what was shown before it stopped. |
| `notices` | The notices to show, in order. |
| `usage` | The tokens the turn used, summed over its model calls: `promptTokens`, `completionTokens`, `totalTokens`. Undefined when the server reported none. |
| `receipts` | What the server said made the turn's answers, in order: a signed receipt per model call (`status: "signed"`), or `unsigned` with the reason when it could not sign one. Empty from a server that sends none. The transcript keeps each receipt's id with its answer. |

## Outcomes

| `outcome` | What happened |
|---|---|
| `completed` | The turn ended normally. |
| `prompt_blocked` | An input check refused the prompt. Nothing of it reached a model. |
| `response_blocked` | An output check stopped the answer. Tool calls in it never run. |
| `tool_denied` | At least one tool call was refused: by the tool mode, by the user, or by the server. The answer may still be complete. |
| `rate_limited` | A limit of the server stopped the turn (429). The notice carries the server's message. |

When a turn has both a refusal and a denied tool call, `prompt_blocked` or `response_blocked` wins over
`tool_denied`.

A refused prompt is never sent to the model again. Of an answer the server stopped, only the question stays in the
history that later requests carry. A turn that was rate limited or over budget is left out of later requests as well,
so the user can send the message again.

## Notices

A notice tells the user about a refusal or a limit. Notices arrive as `notice` events during the turn and are
collected in `result.notices`:

| Field | What it is |
|---|---|
| `outcome` | What it is about: `prompt_blocked`, `response_blocked`, `tool_denied`, `rate_limited`, `round_limit`, `empty_answer`, or another value the server sends. |
| `message` | What to tell the user. For a policy, this is the administrator's message. |
| `stage` | Where it happened: `input`, `output` or `tool`. Optional. |
| `category` | The kind of rule, for example `mode` when the tool mode hid a tool. Optional. |
| `decisionId` | The id auditors and support find the decision by. Optional. |
| `requestId` | The server's id for the request. Optional. |
| `retryAfterMs` | For a limit (429): when to try again, if the server said. Optional. |

A `round_limit` notice means the agent stopped calling tools after the most model calls a turn may make
(`useMaxRounds`). The turn's outcome is still `completed` or `tool_denied`.

An `empty_answer` notice means a model call ended with no text and no tool call, and was not refused or stopped: the
user would otherwise see nothing. Its `category` is `length` when the model used up its length first, often while
thinking (finish reason `length`). The outcome stays what it was. The chat panel says so in the user's language and
offers Retry, as for a failed turn.

```ts
const result = await session.send("Delete pages 3 to 5.");
if (result.outcome !== "completed") {
  for (const notice of result.notices) showNotice(notice.message, notice.decisionId);
}
```

## Errors

Errors are thrown only when a turn cannot run or cannot finish: the server cannot be reached, the sign-in is gone,
the server answered with an error that is not a refusal, or the answer broke off. A turn that fails is recorded with
the status `error` and left out of later requests. `stream` yields no `turn_completed` for it.

All the SDK's errors derive from `FadenstackError`:

| Error | When |
|---|---|
| `FadenstackSignInRequiredError` | The agent's sign-in is gone: never made, expired or revoked. Sign in again. |
| `FadenstackUnreachableError` | No answer at all: the address is wrong, the server is down, or its certificate is not trusted (a browser does not say which). `cause` is the platform's error. |
| `FadenstackApiError` | The server answered with an error. `status` is the HTTP status, and `code`, `type` and `param` are the error's fields. |
| `FadenstackAuthenticationError` | A `FadenstackApiError` for 401. The client has already retried once with a renewed token. |
| `FadenstackPermissionError` | A `FadenstackApiError` for 403: the user may not do this, for example without a grant for the agent or when the agent is retired. |
| `FadenstackRateLimitedError` | A `FadenstackApiError` for 429. `retryAfterMs` says when to try again, if the server said, and `code` which limit applied. In an agent's turn this becomes the outcome `rate_limited` instead. |
| `FadenstackStreamError` | An answer that had started broke off, and the server said so. `code` is the server's code. |
| `FadenstackError` | Also thrown on its own, for example when the server did not answer within `timeoutMs`, or when the agent's profile requires a module the builder does not have. |

When you stop a turn with an `AbortSignal`, the signal's reason is thrown. `isAbortError(error)` from
`@fadenstack/client` is true for it, so you can tell a stop from a failure.

Mistakes in your code throw the platform's errors: a `TypeError` for an address that is not an `https://` URL (unless
you allowed `http://`), and an `Error` for a second turn while one runs, an incomplete builder, or a session that is
not on the device.

```ts
import {
  FadenstackApiError,
  FadenstackSignInRequiredError,
  FadenstackUnreachableError,
  isAbortError,
} from "@fadenstack/client";

async function ask(text: string): Promise<void> {
  try {
    showResult(await session.send(text));
  } catch (error) {
    if (isAbortError(error)) return; // the user stopped it
    if (error instanceof FadenstackSignInRequiredError) return showSignIn();
    if (error instanceof FadenstackUnreachableError) return showOffline();
    if (error instanceof FadenstackApiError) return showError(`${error.status}: ${error.message}`);
    throw error;
  }
}
```

## Errors in your tools

An error thrown by your tool does not end the turn. The model gets `Error:` and the message as the tool's result, the
`tool_completed` event has the outcome `error`, and the model decides what to do next. The same goes for a tool the
model names that does not exist, and for arguments that fail the checks. See
[Tools and approvals](tools.md#arguments-are-checked-first).
