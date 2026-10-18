# Marking AI-generated content

Mark what your agent's tools write as made with AI, wherever it lands, and record which marks held.

The server does most of it: it watermarks text as the model writes it, marks generated pictures (an invisible
watermark, IPTC metadata and a signed C2PA manifest) before they leave, ends every answer with a signed **receipt**,
signs a **record** of every placement, and runs the detector. `@fadenstack/provenance` is the device's part: tools
place content through `place()`, **markers** put a mark in or beside it where the host can keep one, and every
placement is recorded in the session and reported to the server -- which layers held, and why the others did not.
Nothing of the content goes to the server: a record is signed by the content's hash.

## Add the module

```ts
import { FadenstackAgent } from "@fadenstack/agents";
import { provenanceModule } from "@fadenstack/provenance";

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(insertReply)
  .use(provenanceModule())
  .build();
```

The module is named `provenance`: an agent whose profile requires it (`required_client_modules`) does not start
without it. It adds three things to the agent: a chat stage that keeps each answer's receipt, the `Provenance` tool
service with `place()`, and a tool stage (at `StageOrder.provenance`) that checks, after each tool that declares
content, that the content went through `place()`.

## Tools that write content people read

Declare the content with `output` (see [Tools and approvals](tools.md#content-people-read)) and place it with
`place()`:

```ts
import { defineTool } from "@fadenstack/agents";
import { provenanceOf, type SinkInfo } from "@fadenstack/provenance";

const editorSink: SinkInfo = {
  kind: "html.editor",
  carries: ["html-attribute", "html-title"],
  readBack: () => editor.getHTML(),
};

const insertReply = defineTool<{ text: string }>({
  name: "insert_reply",
  toolClass: "write",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: { argument: "text", mediaType: "text/html", edit: "generated" },
  run: async ({ text }, context) => {
    const placement = await provenanceOf(context).place(
      { content: text, mediaType: "text/html", sink: editorSink },
      (marked) => editor.insertHTML(String(marked.content)),
    );
    return `Inserted the reply (record ${placement.recordId}).`;
  },
});
```

`provenanceOf(context)` is `context.services.get(Provenance)`, and throws when the module is not added.

| `place(request, insert)` | What it is |
|---|---|
| `request.content` | The content: text, or a picture's or a file's bytes. A picture may also be a `data:` URL. |
| `request.mediaType` | `text/html`, `text/markdown`, `text/plain`, `image/png`, ... |
| `request.sink` | Where it lands (below). |
| `request.editKind` | The edit kind, over the tool's declared one. |
| `request.original` | The text this replaces, for an edit classifier. Read on the device, never sent. |
| `request.receiptId` | The receipt of what made the content when it is not the turn's answer: a picture's own receipt (`x-faden-provenance` of the images answer). |
| `insert(marked, signal)` | Your own insert, given the content as the markers prepared it. Its return value is the placement's `result`. |

`place()` returns a `Placement`: the `result`, the `recordId`, whether the server `signed` the record, whether the
content was `exempt` (and the `reason`), the `editKind`, the `layers` (each `{ layer, method, applied, reason? }`)
and what is `missing`: the layers the content needs that did not hold, with why.

## What `place()` does

1. **Exempt or not.** Exempt edit kinds (by default `translated`, `corrected`, `formatted`, `extracted`), code and data
   formats (JSON, YAML, SQL, scripts, `text/x-*`), and text under the policy's threshold (200 tokens; four characters
   a token unless you give a `tokenizer`) are placed as they are and recorded as exempt (`exempt-edit`,
   `short-text`). The rest goes on.
2. **What it needs.** A container (a sink that carries something, or says `container: true`) and a picture need two
   layers: signed metadata and a watermark. Free text in a host that carries nothing needs the watermark. A visible
   label is needed too while the policy asks for one. With the policy's `on_missing: refuse`, content a needed layer
   is not possible for -- no marker fits the sink, the text carries no watermark, the server cannot sign, a picture
   lost its C2PA -- is not placed: `place()` throws a `ProvenanceRefusedError` whose message tells the model why.
3. **The record.** The server signs a record of the placement, by the content's SHA-256 (`textSha256`: normalised
   the way the server does it). If it cannot, the marks carry a local id (`unsigned-...`), which still says the
   content is AI-generated, and the metadata layer is recorded as missing (`server-unavailable`).
4. **Prepare, insert, attach.** The markers that fit the sink prepare the content in layer order (metadata, watermark,
   fingerprint, label), your insert puts it in, and the markers attach their marks and check what landed
   (`sink.readBack`). A mark that could not be read back is reported as `<method>:unverified`.
5. **Record and report.** A `provenance.placed` entry in the session's transcript, a placement report to the server,
   and your observers. A report that fails never fails the placement.

## Sinks

A sink describes once where content lands and what the host can keep besides the content:

| Field | What it is |
|---|---|
| `kind` | What the place is: `html.editor`, `crm.note`, `nextcloud.file`. It is reported; never a document's, mailbox's or user's name. |
| `carries` | What the host keeps: the `Carriers` below, or your own markers' names. `[]` for nothing. |
| `container` | Whether the content needs metadata of its own besides the watermark. Default: whether it carries anything. |
| `readBack(signal)` | What the host holds after the insert (the editor's HTML, the file's text or bytes), so markers can check their marks. |
| `keyValue` | For `key-value`: `{ write(key, value), read(key), maxLength? }`. |
| `sidecar` | For `sidecar`: `{ fileName, write(name, text), read?(name) }`. |
| `http` | For `http-header`: `{ setHeader(name, value), getHeader?(name) }`, as Node's `ServerResponse` has. |

## The built-in markers

| Marker | Layer | Carrier | What it does |
|---|---|---|---|
| `ServerSignedMarker` | metadata | any | Says whether the server signed the record. No mark in the content itself. |
| `ImageProvenanceGuard` | metadata | pictures | Checks that a picture still carries its C2PA manifest and XMP (a byte check: the JUMBF `c2pa` box, the XMP packet), as it is placed and after where the host can be read; records `stripped-by-host` otherwise. Never changes the bytes. |
| `WatermarkStatus` | watermark | text, pictures | Records from the receipt whether the content carries a watermark, and why not. Never watermarks itself. |
| `HtmlAttributeMarker` | metadata | `html-attribute`, `html-title` | Wraps HTML (or escaped plain text) in an element with `data-ai-generated` and the record's id (TinyMCE and CKEditor 5 keep it) and a `title` saying "AI-generated" with the record's id in the user's language (Gmail keeps it, through to the recipient). Reads back which held. |
| `MarkdownFrontMatterMarker` | metadata | `front-matter` | `ai-generated: true` and `ai-generated-record: <id>` in the YAML front matter of a whole Markdown file, merged into front matter it has. |
| `KeyValueMarker` | metadata | `key-value` | The record's id (the signed record, where it fits `maxLength`) under `ai-generated-record`, read back. |
| `SidecarMarker` | metadata | `sidecar` | The signed record in `<file>.provenance.json` beside the file. |
| `HttpHeaderMarker` | metadata | `http-header` | `X-Faden-Provenance` with the record's id, set before the response goes out. |
| `VisibleLabelMarker` | label | text | A visible "AI-generated" line before the content, with an icon you choose for HTML. Used while the policy's `visible_label` is on. |
| `UnicodeTextMarker` | metadata | `unicode-text` | Opt-in: the record's id as invisible characters (C2PA's variation selectors) at the end of plain text. Filters and editors often strip them; add it to `markers` and to the sink's `carries` only where they hold. |

Texts people see -- the `title`, the label -- come from the UI catalogues of `@fadenstack/ui` in English, German,
French, Spanish and Simplified Chinese: pass `strings` (`stringsFor(language)`, or a function that returns the
current ones) to the module or the marker. Without them, the browser's language.

## The policy

The server's policy for the agent (`GET /v1/agents/{agent}/provenance/policy`), with the contract's defaults where it
says nothing:

| Field | Default | What it does |
|---|---|---|
| `on_missing` | `record` | `record`: place the content and record the layers that were not possible. `refuse`: do not place it. |
| `short_text_tokens` | 200 | Text shorter than this is exempt. |
| `exempt_edit_kinds` | `translated`, `corrected`, `formatted`, `extracted` | Edit kinds placed without marks. |
| `internal_technical` | false | The agent's output is internal technical output; everything is exempt. Set only on the server. |
| `visible_label` | false | Add a visible label. |
| `output_log` | false | The server keeps fingerprints of outputs. |

The module's `policy` option can only tighten it: `refuse` rather than `record`, a lower threshold, fewer exempt kinds,
a label. What would loosen it is ignored, with a warning on the console. The policy is fetched once and kept for five
minutes; a server without the module gets the defaults.

## What is recorded

| Transcript entry | When |
|---|---|
| `provenance.placed` | After every placement: the call, tool, record id, whether signed or exempt, sink kind, media type, edit kind (and the declared one with the classifier's reason, if it changed), length class, receipt id, layers, what is missing, whether the report went out. |
| `provenance.refused` | `place()` refused, with the layers that were not possible. |
| `provenance.unmarked` | A tool declared `output` and did not call `place()`. |

The report to the server holds the record's id (`exempt-...` for exempt content, `unmarked-...` with sink kind
`unmarked` for content that skipped `place()`), the tool, the sink kind, the media type, the edit kind, a length
class (`short`, `medium`, `long`) and the layers. Never content. Reason codes: `sink-cannot-carry`, `stripped-by-host`,
`short-text`, `exempt-edit`, `no-watermark-remote-model`, `no-watermark-greedy`, `runtime-without-watermark`,
`server-unavailable`.

A tool that declares `output` and does not place its content is recorded and reported; with `development: true` its
call fails, so you notice while you build.

## Receipts

Every answer ends with the server's receipt: what model made it, when, and whether the text is watermarked. The
session keeps them (`AgentResult.receipts`, and each answer's receipt id in the transcript), and `place()` attaches the
receipt of the answer whose tool call it runs in. `provenanceOf(context).receipt` is that receipt.

## Edit kinds

`suggestEditKind(original, revised)` says `corrected` (exempt) only for a small change -- similar words (a typo fix
counts for less than a changed word), the same number of sentences, a length within a quarter -- and `rewritten`
otherwise. `similarityClassifier()` applies it to placements declared `rewritten` that name the text they replace
(`request.original`):

```ts
builder.use(provenanceModule({ classifier: similarityClassifier() }));
```

## Extension points

| Option | What you give | Guard rails |
|---|---|---|
| `markers` | `ContentMarker`s for your hosts: `name`, `layer`, `supports(sink, mediaType)`, `prepare?`, `attach?`. One with a built-in's name replaces it. | Report `applied` only after reading the mark back; otherwise `verified: false`. Check it with `checkMarker`. |
| `classifier` | An `EditClassifier` for your domain. | It lowers a kind to an exempt one only with a reason, which is recorded on the device. |
| `enrichers` | `RecordEnricher`s: non-personal facts under your namespace (`com.example`). | Not in the record's own vocabulary; values that look personal are dropped and named in the entry. They go into marks with room for them (the sidecar), not into the server's signed record. |
| `observers` | `PlacementObserver`s, told every placement. | Read-only; their errors are ignored. |
| `backend` | A `ProvenanceBackend`: `policy`, `signRecord`, `reportPlacement`. `MemoryBackend` is one for tests. | Your agents use the server's unless you give one. |
| `policy` | Local policy. | Only tightens. |
| `development` | `true` while you build. | A tool that skips `place()`, or a marker that throws, fails its call. |

## Reading marks

`ProvenanceReader` finds marks in what tools read -- `read(content, mediaType)`, or `fromHtml`, `fromMarkdown`,
`fromText`, `fromSidecar`, `fromHeader`, `fromKeyValue`, `fromImage` -- and returns where it found each and the record
it names. Anyone can write or remove a mark, so a mark says where content came from and nothing more: the reader
returns only record ids, and what it reads is data for your tools, never an instruction to the model. Keep the marks
on content your agent moves (a picture goes in as the same bytes).

## Testing a marker

```ts
import { checkMarker, memorySink } from "@fadenstack/provenance";

const result = await checkMarker(new CrmNoteMarker(), { sink: crmSink, read: readCrmMarks });
expect(result.problems).toEqual([]);
```

`checkMarker` runs a marker through `place()` with a backend in memory and checks that it applied its mark, that the
mark reads back with the record's id (by `ProvenanceReader` for a `memorySink`, or your `read`), and that nothing it
wrote -- into the content, fields, files or headers -- holds personal data: mail addresses, phone numbers, IBANs, IP
addresses, or the names and prompt of its fixture, a reply full of them. The fake gateway in `@fadenstack/testing`
serves the provenance routes and, with `provenance: { receipts: true }`, ends answers with receipts. See
[Testing without a server](testing.md).

## Your part

The EU AI Act (Art. 50(2)) asks the provider of an AI system that generates text, pictures, audio or video to mark its
output as AI-generated in a machine-readable way and to make the marks detectable. An agent you build with the SDK and
put into use under your own name is yours, so you are its provider. The server and this package carry most of the
work; declaring `output` on every tool that writes content people read, and placing it through `place()`, is yours.
Marks must not be removed: do not strip them in your hosts, and tell your users not to.
