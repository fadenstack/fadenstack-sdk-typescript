# Machine policy

An organisation that manages its computers can set, for every app built on the SDK, whether its agents may use the
person's own model, which endpoints, and whether local MCP servers, local skills, web search and plain http in the local
network are allowed. The app reads the policy from its managed location; the SDK enforces it. A browser has no policy
file: a Chrome extension hands `chrome.storage.managed`'s object to the SDK.

```ts
const policy = MachinePolicy.from(await chrome.storage.managed.get()); // MachinePolicy.none when there is none
const agent = FadenstackAgent.createBuilder()
  .useEndpoint(endpoint).useLocalProfile(definition)
  .useMachinePolicy(policy) // build() refuses what the policy forbids
  .build();
```

## Keys

| Key | Values | Default |
|---|---|---|
| `server` | the organisation's server; the app enrols, and the person signs in at the next start | none |
| `standalone` | `allowed`, `forbidden` | `forbidden` when `server` is set, else `allowed` |
| `endpoints` | a list of allowed bases or origins (`https://llm.example`, `http://localhost:11434`) | any |
| `plainHttp` | `allowed`, `forbidden`: plain http in the local network (this computer stays allowed) | `allowed` |
| `mcp` | `allowed`, `forbidden`, or a list of allowed local MCP sources | like `standalone` |
| `skills` | `allowed`, `forbidden`, or a list of allowed skill folders | like `standalone` |
| `webSearch` | `allowed`, `forbidden` | like `standalone` |
| `timestamping` | `on` (DigiCert), `off`, or the address of the organisation's own time-stamp server: RFC 3161 time-stamps for records signed on the device (only a hash leaves); anything else is `off` | `on` |

## Rules

- **Fail closed.** An unknown key is ignored and reported in `policy.warnings`; an unknown value narrows to `forbidden`; a
  policy that is not an object forbids standalone, local MCP, local skills, web search and plain http. A warning names the
  key, never the value. `MachinePolicy.fromJson` throws a `SyntaxError` for text that is not JSON: forbid in that case too.
- **The policy wins over the person's settings**, and with a server it narrows what the server allows (a server's
  `local_mcp` allow is off when the policy forbids local MCP, on every read and refresh of the profile); it never turns on
  what they left off.
- **Enforced in the SDK:** `build()` throws `MachinePolicyError` (with its `key`) for an agent on an endpoint the policy
  forbids or does not list; with only listed endpoints, a host's own streamer is refused, since it names none. Plain http
  forbidden takes the endpoint's LAN opt-in away (`EndpointPlainHttpRefusedError`, reason `forbiddenByPolicy`).
- **Time-stamps:** the provenance module's device backend asks the policy's own server where `timestamping` names one,
  and sends no RFC 3161 request where it is `off`.
- **Lists are the modules' to apply:** `agent.machinePolicy` gives a module the listed MCP sources and skill folders.
- **Locked values:** `policy.locked` names the keys the policy set; the app locks them in its UI and never writes them into
  the person's settings.
- **Enrolment keeps data apart:** an agent on the person's own endpoint keeps its chats under the standalone principal's
  own databases, never uploaded, and its "Allow always" decisions do not carry over to the organisation's agent.
