# Server-held grants and Bypass

The server can hold what a person let the agent do for a while without asking: a grant for **a time** for one tool, a
grant for **a stretch of work** in some places, and **Bypass**, which switches approvals off in one conversation. The
SDK offers all three, on the same wire as the .NET SDK.

The profile must advertise `approval_scopes.grant`, provide approval limits and identify the authenticated device.
Older servers offer no time/work permissions. `agent.grants.settings`, `choices` and `bypassChoices` are empty
unless the server says so: an `approvals` block without the feature is not read as grants. Native permissions and the
stricter tool class still apply; a time or work grant never covers an administrator's approval floor, contract
`approval: always`, or a destructive or unclassified action. Bypass covers the destructive and unclassified calls
the gateway says it covers, in its own conversation, and nothing else that asks every time (see
[Bypass](#bypass)).

## A grant for a time

The shared approval request offers `grantDurations` only for eligible calls: a read or write the agent's limits cover,
within its longest grant. Vue and React render those choices with the existing shared style. A choice enters
**Confirming permission with the server**; it does not claim a grant exists before the response. The SDK reports the
confirmed/narrowed duration or an individual approval with a notice to inspect active grants if the grant cannot be
confirmed. A timed choice applies to that tool across the person's chats on the device; the card states this scope.
Custom strings can override the new optional labels.

`agent.grants` exposes `refresh()`, `live`, `find()`, `onChanged()`, `pause()`, `resume()`, `revoke()`, `revokeAll()`
(the marker's Stop) and `extend()`. These use server replies; a failed resume/extension never creates a local
substitute. The `live` countdown is display data, not authority. An uncertain grant creation must be inspected before
another is requested. `revokeAll()` ends every grant this device holds for the agent, one after the other; the grants
are replaced by what the server answers each time.

Only a matching `faden.grant_used` event lets an agent call consider grant coverage. The SDK then reads the current
grant, checks agent/version/device/conversation, status, expiry, budget and scope, and reads it again before native
dispatch. The final already-reserved quota call may report `spent`; that status alone never authorizes an unmarked call.
Duplicate call IDs in a turn cannot reuse a local reservation. Expired, paused, revoked, missing or uncheckable grants
require a fresh individual approval. Central Deny/hidden modes still refuse execution. A grant the SDK cannot read -- a
later kind, status or evidence level -- is left out of a list, and the others stand.

`agent.grants` is replaced, never added to, by every list the server sends: the list a stream starts with
(`faden.grants`) and `refresh()`. A list that is malformed, or holds a grant of another agent version or device,
clears the copy. A chat reopened with `agent.openSession()` reads the grants again first (offline, the copy as it is).

## A grant for a stretch of work

For work grants, the reviewed host contract maps `target_type` and a JSON pointer `target_argument`. Configure
`useGrantPlaceResolver()` with native authorized canonical resolution. Without a resolver, work coverage is
unavailable.

Where a call acts is matched by the gateway on the **text** of the path, which cannot see that a link, a junction or a
mount point on the device leads somewhere else (ASVS 5.0 5.3.2; CWE-59). A browser has no file system to ask, so the
**host adapter** resolves canonical paths: for a place that names a path on the device (a `document`, a `folder` or an
`app`, with a path such as `/srv/share/a.txt`, `C:\Docs\a.txt` or `\\server\share`) the resolver must return the path
as the operating system reports it -- every link, junction and mount point resolved, a file that does not exist yet
below the real path of the part that does -- and `null` when it cannot tell. The SDK resolves the call's place and
each of the grant's places the same way and compares the real paths (case as given: a difference of case asks).

- The real place lies in a real place of the grant: the call is covered.
- It does not: the call is **not** covered, the person is asked, the request carries `leadsOutside` (where the place
  really leads, for the card to say) and the `approval.decision` entry records `outside_grant: true`.
- The resolver gives `null`: the person is asked, with the class's own reason.

A place that names no path on a device (a site by origin, a desk, an app by name, a document by its URL or id) is
matched by its text, as the gateway does. Not caught: a hard link, and a link that changes between this check and the
tool's own opening of the path. The native adapter must still resolve redirects/junctions and recheck its own access,
scope and exact destination independently before an effect.

Call `agent.grants.grantWork(places, duration, conversationId, shownText)` only after a human confirms those canonical
places and actions. Returned scope must fit the confirmed request. Or let the session draw the card:
`session.offerWork(places, reason)` asks the app's grant handler (`useGrantHandler`; an approval handler with
`requestGrant` is used when none is given) with the places, the classes, the durations within the agent's longest
grant and 30 minutes preselected, and makes the grant with the places the person kept. `session.offerExtension(grant,
more, places)` does the same for an extension, which the server keeps within the agent's longest grant from when the
grant was made (`narrowed` says it cut the time). `grantForTime()` is similarly explicit; it is never a model tool.

## Bypass

Bypass is the server's: a person switches approvals off for one conversation for a while, after signing in again in the
browser, where the organisation and the agent allow it. Within that conversation, what the mode would ask about runs --
the destructive and unclassified calls the gateway says the grant covers too -- and the server records every call. It
never covers an administrator's rule, a tool that asks every time, or the server's own questions, and a person's own
command is asked individually. Only the person starts it, in the app: no tool and no other agent can.

It is offered only where the app can complete the flow, and announced only together with it. An agent built with a
step-up handler (`useStepUpHandler`, or an approval handler with `open` and `report`) sends
`X-Faden-Client-Supports: tool_mode.bypass, bypass.step_up` on every request; the server then adds the profile's
`approvals.bypass` and may offer `bypass` as the agent's highest level. An agent without one announces nothing, so the
server offers no Bypass. `agent.bypassOffered` says whether it is offered now, `agent.ceiling` is `bypass` only then, and
`agent.grants.bypassChoices` are the durations the card may offer (15 minutes up to the server's longest). A browser
page that calls the server from another origin needs that origin to allow the header.

```ts
const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .useApprovals(myCards)          // also has requestGrant(...) for the Bypass card, and open/report for the sign-in
  .useStepUpHandler(browserStepUp(showWaiting)) // or your own: open the page in the system browser or a new tab
  .build();

const session = await agent.startSession();
const grant = await session.startBypass("Renaming 400 drawings"); // card, then second sign-in, then the server's grant
session.bypass;                  // the live grant: the marker counts down by agent.grants.serverNow
await session.stopBypass();      // ends it from the next call on; the chat goes back to the mode it had before
```

- **The card comes first.** `startBypass()` draws the confirmation (`GrantOffer.bypass`, with `evidence` and the
  durations; 30 minutes preselected, else the longest offered); a card that cannot say what Bypass means answers
  `GrantAnswer.notNow`. The person's own words (`GrantAnswer.reason`, at most 500 characters, cut at a character's end)
  go with the grant's record. A card cannot widen the offer: the time is within the durations offered.
- **The second sign-in comes after the card's Allow**, never before and never on the model's word (ASVS 5.0 7.5.3). The
  step-up handler's `open(request)` opens `request.link` in the system browser or a new window or tab -- **never an
  iframe** of the app's page; `openInBrowser()` does it for a web page and gives `false` where the browser blocks it --
  and `report(request, stage)` shows `browser`, `approved`, `denied`, `timed_out`, `failed` or `cancelled`. The
  SDK polls the server (`slow_down` makes it wait longer), shows the user code, and refuses a page that is not on the
  API's own origin (scheme, host and port, no user in the address): nothing is opened then.
- **The proof lives in memory only**, in the agent object: never in a transcript, a store, a log, a record or a
  report. One proof serves the parallel chats of the agent for five minutes by the server's clock (less 15 seconds); a
  proof the server no longer takes is dropped and the sign-in asked once more, without a new token.
- **The server's grant is the record.** Bypass holds only once the server answered with a grant of this kind, for this
  conversation, no longer than confirmed; a refusal is thrown (`FadenstackApiError`, `bypass_not_allowed`), a sign-in
  that did not happen is a `BypassSignInError` with the `stage`.
- **Under Bypass** the session runs in `bypass` mode (`X-Faden-Tool-Mode: bypass`) while the conversation's grant is
  live; without it, the mode reads as `auto`. A call is covered only when the gateway says so (`faden.grant_used`) and
  the SDK reads the conversation's own, active grant from the server. Another conversation's Bypass covers nothing.
- **The turn is reported.** After a turn in Bypass the calls the device ran without the person's answer go to the
  gateway (`reportGrant`), which compares them with its own records. Calls the person was asked about are not in it.
- **When it ends**, the model is told once, in its next request, that tools ask again and that only the person can switch
  Bypass on. `agent.grants.whyEnded(id)` says why a grant ended: `person`, `admin`, `kill_switch`, `limit`, `agent`,
  `expired` or `spent`; null while it runs, or when the server cannot say.
- **A Bypass grant is never extended.** More time is a new Bypass with the card and the sign-in again.
- **A chat reopened** (`agent.openSession()`) is in Bypass only while its grant lives; else in the mode it had before,
  never from the transcript.
- **The app's end and the next start.** Call `agent.grants.pauseBypass()` when the app ends (it pauses the device's running
  Bypass grants; their time runs on) and `agent.grants.resumeBypass()` when it starts: grants paused less than 30
  minutes ago by the server's clock resume without a card or a sign-in -- the server checks that Bypass is still
  allowed -- and the others are ended. It returns those that did not resume, with why: `paused_too_long`, the words of
  `whyEnded`, `ended`, or `unavailable` (the server could not check: it stays paused).

`usePermissionMode("bypass")` is the same path, started by the app's code: no card, the longest time, the reason
`PermissionMode.Bypass`, the same second sign-in and the same grant, before the first turn that would ask, never from
`off` or `read_only`. Where Bypass cannot be had -- the server does not offer it, or the app opens no second sign-in --
a session that would ask runs in `auto` instead (never above `useDefaultToolMode` or the ceiling) and the agent warns once.

## Stores per signed-in user

Sessions and what was allowed always are kept in the signed-in user's own IndexedDB databases
(`fadenstack-sessions:<tenant>:<user>`, `fadenstack-approvals:<tenant>:<user>`, each part escaped), so two people in one
browser profile never see each other's. The gateway names the user in the profile's `principal`; from one that does
not, the shared databases of an older SDK are used. What an older SDK kept in the shared databases is **not** moved to
a user: in a browser profile nobody can say whose it is. A store you pass (`useSessionStore`, `useApprovalStore`) is used
as it is, and keeping people apart is then yours. `agent.listApprovals()` lists what the person allowed always, for a
settings page; `agent.resetApprovals(tool?)` ends it.

## The profile

A session's start or opening reads the profile again when the one held is older than a minute: a ceiling an
administrator lowered, an agent's highest level, or a tool's class or approval reach the next session without a restart.
The agent and the signed-in user must be the same; a change throws. When the server cannot be reached, the profile held
stays.

## Names

The public names follow the .NET SDK: `ApprovalSettings`, `BypassSettings`, `StepUpSettings`, `ToolModeSettings`,
`AgentGrants`, `GrantPlace`, `GrantOffer`, `GrantAnswer`, `GrantScope`, `GrantStepUp`, `StepUpProof`, `StepUpRequest`,
`ApprovalDecision.forTime` and `ApprovalDecision.approveFor()`. TypeScript uses camelCase and drops C#'s `Async` suffix.
`GrantPlace.document/folder/site/app/desk` mirror the .NET factories.

Durations are **milliseconds**, the TypeScript equivalent of .NET `TimeSpan`. `AgentGrants.durations`, `preselected`,
`choices`, `remaining()` and `ApprovalRequest.grantDurations` use the same unit. Wire `minutes`, `remaining_s` and
`expires_in` retain the server's units. For example, .NET `TimeSpan.FromMinutes(30)` corresponds to TypeScript
`30 * 60_000`. `AgentGrant.remainingS` mirrors .NET `RemainingS`. `pollStepUp()` returns named `proof/error/interval`
fields corresponding to the .NET polling tuple.

Explicit `user_command`/`user_history` paths keep individual approval. The shared level/work-grant management UI
(the cards, the marker, Settings > Approvals and their texts) is a separate package.

A call a grant let through is recorded in the transcript with `grant_id`, and for a time grant `grant_minutes` (the time
the person picked) and `grant_confirmed_minutes` (what the server confirmed), the keys the .NET SDK writes and reads;
`outside_grant` says a link led the call's place out of a work grant's places.
