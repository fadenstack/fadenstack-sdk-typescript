# Samples

Open source (Apache-2.0): the SDK's showcase. [docs/samples.md](../docs/samples.md) has the details.

| Sample | What it shows |
|---|---|
| `livecheck.mjs` | Checks an SDK setup against a running Fadenstack server. |
| `web-standalone/` | A page that runs in the browser on your own model: the connection wizard, the chat panel, a tool that asks before it writes, content marking, Stop everything and "Your data in this browser". |

## The web page on your own model

No server, no account. From the repository's root, after `npm ci`:

```bash
npm run sample:web          # serves http://localhost:5173
npm run sample:web:build    # builds it into samples/web-standalone/dist
```

Open the page, choose "Use my own AI", accept the terms, and pick or type your endpoint. The page asks the endpoint directly from the browser, so the endpoint must allow the page's origin (CORS). A key you type goes to the SDK's own key store in this browser (a WebCrypto key; sealed bytes only), never to the address bar, a file or a log.

**Ollama.** Allow the page's origin, then start Ollama:

```bash
# Windows PowerShell
$env:OLLAMA_ORIGINS = "http://localhost:5173"; ollama serve
# macOS / Linux
OLLAMA_ORIGINS=http://localhost:5173 ollama serve
```

Pull a model that calls tools (`ollama pull qwen3:14b`) and use the Ollama preset (`http://localhost:11434/v1`).

**LM Studio.** Load a model, open the Developer tab, turn on "Enable CORS", and start the server (`http://localhost:1234/v1`).

Then try "Save a note: buy milk". `save_note` is a write tool, so the chat shows a card and asks first; the note lands in the page's own list only after you allow it. The Copy button under an answer marks the copy as AI-generated. The stop button in the header is Stop everything; the gear opens "Your data in this browser".
