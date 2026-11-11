# Server-held time and work grants

The profile must advertise `approval_scopes.grant`, provide approval limits and
identify the authenticated device. Older servers offer no time/work permissions.
Native permissions and the stricter tool class still apply; a grant never covers
an administrator's approval floor, contract `approval: always`, or a destructive
or unclassified action.

The shared approval request offers `grantDurations` only for eligible calls.
Vue and React render those choices with the existing shared style. A choice enters
**Confirming permission with the server**; it does not claim a grant exists before
the response. The SDK reports the confirmed/narrowed duration or an individual
approval with a notice to inspect active grants if the grant cannot be confirmed.
A timed choice applies to that tool across the person's chats on the device;
the card states this scope. Custom strings can override the new optional labels.

`agent.grants` exposes `refresh()`, `live`, `onChanged()`, `pause()`, `resume()`,
`revoke()` and `extend()`. These use server replies; a failed resume/extension never
creates a local substitute. The `live` countdown is display data, not authority.
An uncertain grant creation must be inspected before another is requested.

Only a matching `faden.grant_used` event lets an agent call consider grant coverage.
The SDK then reads the current grant, checks agent/version/device/conversation,
status, expiry, budget and scope, and reads it again before native dispatch.
The final already-reserved quota call may report `spent`; that status alone never
authorizes an unmarked call. Duplicate call IDs in a turn cannot reuse a local
reservation. Expired, paused, revoked, missing or uncheckable grants require a
fresh individual approval. Central Deny/hidden modes still refuse execution.

For work grants, the reviewed host contract maps `target_type` and a JSON pointer
`target_argument`. Configure `useGrantPlaceResolver()` with native authorized
canonical resolution. Without a resolver, work coverage is unavailable. The SDK
does not perform local filesystem realpath checks or follow arbitrary URLs.
The native adapter must resolve redirects/junctions and recheck its own access,
scope and exact destination independently before an effect.

Call `agent.grants.grantWork(places, duration, conversationId, shownText)` only after a
human confirms those canonical places and actions. Returned scope must fit the
confirmed request. An application-owned work card and active-grants management
view can use this API; the standalone shared work/Bypass UI remains separate from
the per-tool time card. `grantForTime()` is similarly explicit; it is never a model tool.

The public names follow the .NET SDK: `ApprovalSettings`, `BypassSettings`,
`StepUpSettings`, `ToolModeSettings`, `AgentGrants`, `GrantPlace`, `GrantScope`,
`GrantStepUp`, `StepUpProof`, `ApprovalDecision.forTime` and
`ApprovalDecision.approveFor()`. TypeScript uses camelCase and drops C#'s `Async`
suffix. `GrantPlace.document/folder/site/app/desk` mirror the .NET factories.

Durations are **milliseconds**, the TypeScript equivalent of .NET `TimeSpan`.
`AgentGrants.durations`, `preselected`, `choices`, `remaining()` and
`ApprovalRequest.grantDurations` use the same unit. Wire `minutes`, `remaining_s`
and `expires_in` retain the server's units. For example, .NET
`TimeSpan.FromMinutes(30)` corresponds to TypeScript `30 * 60_000`.
`AgentGrant.remainingS` mirrors .NET `RemainingS`. `pollStepUp()` returns named
`proof/error/interval` fields corresponding to the .NET polling tuple.

Explicit `user_command`/`user_history` paths keep individual approval. The server's
Bypass is not offered or announced by this implementation yet; until it is,
`usePermissionMode("bypass")` runs a session that would ask in `auto` instead and
approves nothing on its own (see [Tools and approvals](tools.md#bypass-mode)). Its
step-up flow and shared level/work-grant management UI come with it.

A call a time grant let through is recorded in the transcript with `grant_id`,
`grant_minutes` (the time the person picked) and `grant_confirmed_minutes` (what the
server confirmed), the keys the .NET SDK writes and reads.
