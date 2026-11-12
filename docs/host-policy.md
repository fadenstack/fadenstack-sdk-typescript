# Central policy before native host execution

This page is written for a host that runs native tools. [Host commands and central policy](host-commands.md) is the guide to
`invokeTool`, `streamTool` and the check on the wire.

A gateway advertising `host_tools.dispatch_check` supports fresh policy checks for
model-requested host tools. The agent automatically uses them once negotiated.
Older gateways retain their legacy behavior. Hosts that require this guarantee
must build with:

```ts
const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(...nativeTools)
  .requireHostToolPolicyChecks()
  .useApprovals(approvals)
  .build();
```

Required mode refuses startup when the capability is absent. Losing support after
negotiation fails closed; it does not silently restore legacy execution.

For each model-requested host call, the SDK refreshes the authenticated profile,
checks the pinned schema and current central policy with origin `model_tool`, and
binds the model's call ID. A caller cannot claim its own class or a native access
right. The SDK applies the stricter native class, mode, contract approval and rule
floor. It then requests any required approval through the normal shared handler.

Immediately before the final native invocation, the SDK refreshes policy again,
compares approval controls and performs the `dispatch` check. Identity, contract,
arguments, comparison stamps, mode restrictions or approval-limit changes refuse
the call. Network errors and malformed responses permit no native fallback.
Normal gateway policy-cache boundaries still apply; this is not a claim of an
atomic distributed lock with the administrator's console.

The final tool-stage arguments must match the reviewed cloud-visible arguments.
An integrator cannot disclose locally unmasked PII through this new check endpoint:
transformed arguments are refused until that combination has a separately reviewed
disclosure contract. Native providers remain responsible for their final prepared
payload, current ACL, audience, scope and conflict preconditions.

`user_command` and `user_history` keep their existing prepare/dispatch route and
individual-command behavior. Policy comparison stamps are not signed execution
permits, credentials, or evidence that a native effect committed. The host still
requires one-use native proposals and truthful effect receipts. Do not automatically
retry a mutation after an uncertain native outcome.

Local MCP execution is outside this host-only path; a host contract is not permission
to invoke an arbitrary MCP tool. Applications that do not offer local MCP should
continue to disable it in their published agent version.
