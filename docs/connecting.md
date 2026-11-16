# Connecting an agent

The first time an app starts, and later in its settings, the person chooses how the agent works: with the
organisation's Fadenstack server ("Connect to my organisation") or with an AI server of their own ("Use my own AI").
`ConnectionWizardViewModel` (`@fadenstack/ui`) walks them through either way. It is one headless state machine that the
skins draw: `ConnectionWizard` in `@fadenstack/ui-react` and in `@fadenstack/ui-vue`. At the end the app gets a
`ConnectionResult` and builds the agent from it, with `useServer` or `useEndpoint`. The .NET SDK has the same wizard
under the same names.

```tsx
import { ConnectionWizardViewModel, createServerSignIn, stringsFor } from "@fadenstack/ui";
import { ConnectionWizard } from "@fadenstack/ui-react";

const wizard = new ConnectionWizardViewModel(
  {
    agents: ["browser-assistant"],             // the app's agents, the main one first: one approval signs in all
    passwordFallback: true,                    // e-mail and password for a server without pairing
    canSearchThisComputer: false,              // a browser does not scan ports
    termsVersion: "2026-11",
    policy,                                    // MachinePolicy.from(await chrome.storage.managed.get())
    steps: [hostPermissionStep],               // Chrome's permission, before every endpoint check
    pairingKeeper: sessionKeeper,              // chrome.storage.session: the pairing survives closing the panel
  },
  connectionStore,
  {
    server: createServerSignIn({ tokenStore, agents: ["browser-assistant"], deviceLabel, client, policy }),
    keys: endpointKeyStore,
    strings: stringsFor(navigator.language),
    language: navigator.language,
  },
);
wizard.onCompleted((outcome) => { /* "connected": build the agent from wizard.result */ });
root.render(<ConnectionWizard wizard={wizard} appName="Browser assistant" onOpenTerms={openTerms} />);
await wizard.start();
```

## The two ways

**Connect to my organisation.** The person types the server's address, unless the machine policy sets it and locks
it. The wizard checks the address with `checkServer` (`GET /api/health`). It then shows a pairing code, and the person
approves it on the console's `/pair` page. One approval signs in all of the app's agents. The tokens go to the token
store. A server without pairing gets the e-mail and password sign-in when `passwordFallback` is on. Every failure has
its own step, and its own words in five languages.

**Use my own AI.** The person reads where their data goes, the provider's terms and the standalone notice, and ticks
the consent box, which starts unticked. The wizard keeps an acceptance record: terms version, time, language and mode.
The person picks a preset or types an address. A key goes straight into the key store. Plain http goes only:
- to this computer (`localhost`, `127.0.0.1`, `[::1]`), where a key may go too;
- to the local network after the person confirms it, and never with a key.

In a browser, names are not resolved: a name counts as local only by its form. The check then says in plain words
what works, what limits the connection and whether it watermarks text. Last, the person picks the model.

## In a browser

- **The user gesture.** Chrome asks for a host permission only inside a click. The app's step at
  `beforeEndpointCheck` therefore runs before the first `await` of the command that starts a check, and the skins
  call the view model synchronously in their click handlers. Saving a key comes first, briefly, because the step gets
  the key's provider.
- **A pairing that survives the panel.** With a `pairingKeeper`, the wizard keeps the pairing while its code shows.
  The keeper's `keep`, `restore` and `forget` read and write `chrome.storage.session`, which lives in memory for the
  browser session. The pairing is forgotten when the wait ends. When the panel opens again, the wizard goes on at the
  code, if the pairing has not expired and is for the same server. What is kept includes the pairing code, the secret,
  so it belongs in session storage only (`AgentPairing.export` and `resume`).

## What the app gives

| Contract | What it is |
|---|---|
| `ConnectionStore` | Where the app keeps the connection (`chrome.storage`): the server, the result, the acceptance record, and sign-out. Never a key or a token. |
| `EndpointKeyStore` | The key store for endpoint keys (a WebCrypto key). `save` returns a token provider that reads the key when a request needs it. |
| `WizardStepHandler` | The app's own steps, at four points: `beforeChoice`, `beforeServerCheck`, `beforeEndpointCheck`, `afterConnect`. A step that says no stops the flow. |
| `WizardOptions` | What the app offers, its agents and the required ones, the password fallback, whether it can search this computer, the terms version, the machine policy, the pairing keeper. |
| `createServerSignIn`, `createEndpointChecker` | The default server and endpoint sides over the client. Tests pass fakes. |

The entry (`WizardEntry`) is `firstRun`, `serverKnown`, `reSignIn` (with the "your sign-in ended" banner) or `settings`.

## The machine policy

The [machine policy](machine-policy.md) shapes the choices:
- `server` opens the server path with the address locked;
- `standalone: forbidden` hides "Use my own AI";
- `endpoints` narrows the presets and a typed address;
- `plainHttp: forbidden` refuses plain http to the local network, and a key over plain http even to this computer.

## Secrets and texts

No secret stays in the view model (OWASP ASVS 5.0 V13):
- the password and the key are method parameters, read from an uncontrolled password input when the button runs and
  cleared at once;
- only `keySet` remains.

A newer action makes every older one's answer stale. A store that fails says so (`storeFailed`). Every text is a
`UiStrings` member whose name starts with `wizard`, in five languages. The view model adds the texts that follow its
state: `addressErrorText`, `problemText`, `waitingText`, `resultLines` and the others. When the app's language changes,
`wizard.retext(strings)` reads every one of them again from the new `UiStrings` and notifies the skin; the step, the typed
values and the check result stay as they are. The standalone notice and the liability sentence are legal texts: their
German version is the binding one.
