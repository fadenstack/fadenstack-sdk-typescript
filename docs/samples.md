# Samples

This page covers the samples in the SDK's repository: a script that checks an SDK setup against a server, and the same script run against the fake server. The repository has no console or chat-panel sample like the .NET SDK's; the [chat panel](chat-panel.md) and [Build an agent](agent.md) pages have the code to start from.

Run the samples from the repository's root with Node.js 24 or later, after `npm install` and `npm run build`.

## LiveCheck

`samples/livecheck.mjs` drives the SDK against a running server and reports, check by check, what works. It is the TypeScript counterpart of the .NET SDK's LiveCheck. Use it to check an SDK setup against your server.

```bash
FADEN_USER_EMAIL=user@example.com FADEN_USER_PASSWORD=... \
  npm run livecheck -- --server https://ai.example.internal --agent browser-assistant
```

| Option | Meaning |
|---|---|
| `--server` | The Fadenstack server. Or set `FADEN_SERVER`. |
| `--agent` | The agent's slug. `browser-assistant` by default. |
| `--allow-http` | Allows plain `http://` to another machine, for a development server. The password and the tokens then cross the network readable. Plain `http://` to this machine (`localhost`, `127.0.0.1`, `::1`) is allowed without it. |

The user's e-mail and password come from the environment (`FADEN_USER_EMAIL`, `FADEN_USER_PASSWORD`); the script prints a usage line and ends with exit code 2 when the server or either of them is missing. If the server's certificate is issued by a CA that Node does not trust, set `NODE_EXTRA_CA_CERTS` to the CA's file.

The agent must be granted to the user, and its host tool contract must list the two tools the script defines: `read_context` (class `read`) and `fill_field` (class `write`). These are the browser agent's tools; its contract is `contracts/browser-assistant.json` in the `faden-agent-chrome` repository.

The checks run in this order, each printed as `PASS` or `FAIL` with its time:

| Check | What it does |
|---|---|
| `signin` | Signs in with the password and exchanges the login token for the agent sign-in. |
| `profile` | Starts the agent and reads its profile: name, version, model and the tools with their classes. |
| `chat` | Asks for a short answer and expects text back. |
| `host-read` | Asks about a page that only `read_context` can read, and checks that the tool ran and the answer holds the value. |
| `ask-approve` | In `ask` mode, asks for `fill_field`, and checks that an approval was recorded and the tool ran. |
| `read-only-hides-writes` | In `read_only` mode, asks for `fill_field`, and checks that it did not run. |
| `refresh` | Invalidates the access token, checks that a new one is issued, and uses it. |
| `events` | Sends the agent's reports and checks that none failed (`agent.lastReportError`). |

At the end it prints how many checks passed and exits with code 1 if any failed, 0 if all passed. The script keeps its sessions in memory and the sign-in in a `MemoryTokenStore`, so it leaves nothing on the machine. It approves every tool call itself, so run it against a test agent, not one with real data behind its tools.

## LiveCheck against the fake server

`samples/livecheck-fake.mjs` runs `livecheck.mjs` against a `FakeGateway` from [`@fadenstack/testing`](testing.md), served over HTTP on a free local port, with a scripted model. It proves the live check itself before you point it at a real server.

```bash
node samples/livecheck-fake.mjs
```

It reads the browser agent's contract from `../../faden-agent-chrome/contracts/browser-assistant.json`, so the `faden-agent-chrome` repository must be checked out in the same folder as the SDK's repository (a sibling of it). It signs in as a user it creates itself. It takes no options.
