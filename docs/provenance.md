# Marking AI-generated content

Mark what your agent's tools write as made with AI, wherever it lands, and record which marks held.

The server does most of it: it watermarks text as the model writes it, marks generated pictures (an invisible
watermark, IPTC metadata and a signed C2PA manifest) before they leave, ends every answer with a signed **receipt**,
signs a **record** of every placement, and runs the detector. `@fadenstack/provenance` is the device's part: tools
place content through `place()`, **markers** put a mark in or beside it where the host can keep one, and every
placement is recorded in the session and reported to the server -- which layers held, and why the others did not.
Nothing of the content goes to the server: a record is signed by the content's hash. The .NET SDK's
`Fadenstack.Provenance` does the same, step for step and byte for byte ([below](#the-same-in-both-sdks)).

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
  container: true, // the editor's HTML carries metadata: the content needs a mark of its own
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
    return placement.recordId ? `Inserted the reply (record ${placement.recordId}).` : "Inserted the reply.";
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
| `insert(marked, signal)` | Your own insert, given the content as the markers prepared it (`marked.content`, and `marked.hostValues`: what a marker prepared for this insert, below). Its return value is the placement's `result`. |

`place()` returns a `Placement`: the `result`, the `recordId` (undefined for exempt content and when the server could
not sign), whether the server `signed` the record, whether the content was `exempt` (`reason` `exempt-edit`, and
`exemptBecause`: `internal-technical`, `edit-kind`, `code`, `label`, or `not-content` below), the `editKind`, the
`layers` (each `{ layer, method, applied, reason?, verified? }`) and what is `missing`: the layers the content needs
that did not hold, each `{ layer, method, reason }`.

**When the insert fails.** If your insert throws after the server signed the record, the placement is still reported
and recorded -- the record's id, every layer `applied: false` (the transcript's `detail` says `insert failed: <error>`)
-- so the server's placements match its records; then `place()` throws your error on. The report says it was not
written (`written: false`) and names the error by a short code (`failure`: its `name`, other characters as `_`, at
most 64), never by its message; the server marks the record "not written".

**Arguments that are not content.** A tool that writes text for people in one call and picks an option or ticks a
check box in another says so per call: its `edit` function returns `null` for a call whose argument is not content.

```ts
output: { argument: "value", mediaType: "text/plain", edit: ({ kind }) => (kind === "text" ? "generated" : null) },
```

For such a call `place()` puts the value in as it is -- no record, no mark, no report, no transcript entry -- and
returns a placement with `exempt: true` and `exemptBecause: "not-content"`; a call that does not use `place()` at all
is not recorded as unmarked. An `editKind` in the request makes it content again.

**Host values.** A marker that needs the host's insert to write something with the content -- Word's bookmark, inside
the insert's own undo entry -- prepares it for this one placement: `withHostValue(content, key, value)` in `prepare`.
The insert reads `marked.hostValues[key]` and `attach` reads `placed.hostValues[key]`. `OfficeMarks.anchorValue`
(`office.anchor`) is the key for the anchor's name (`officeAnchorName`). Ids and names only: host values stay on the
device.

## What `place()` does

1. **The policy and the edit kind.** The server's policy, tightened by the module's; the edit kind from the request,
   else the tool's `output`, else `generated`, then the classifier.
2. **Exempt or not.** Content exempt from marking is placed as it is, with no record, and recorded as exempt: the
   policy's `internal_technical`, an exempt edit kind (by default `translated`, `corrected`, `formatted`,
   `extracted`), code and data (JSON, XML, YAML, SQL, scripts, `text/x-*`), and labels -- at most three words and 40
   characters without a sentence mark, or 8 characters of CJK text ("Approved", "Q3 revenue"). **Short text is not
   exempt**: it is recorded and marked like any other; only the model's watermark is not expected under the policy's
   threshold (200 tokens), and the watermark layer says `short-text`.
3. **What it needs.** Signed metadata in a container (a sink with `container: true`) and for every picture; the
   watermark for text from the threshold on and for every picture; a visible label for text while the policy asks
   for one. What can be known before anything is signed is checked here -- no marker fits a container, the receipt
   says the text carries no watermark, a picture lost its C2PA. With the policy's `on_missing: refuse`, `place()`
   refuses (below).
4. **The record.** The server signs a record of the placement, by the content's SHA-256 (`textSha256`: normalised the
   way the server does it); for HTML and Markdown also by the SHA-256 of the text a reader sees (`text_sha256`,
   below), so the words someone copies out of the editor find the record. If it cannot, **no marker runs** -- no mark
   carries an id the server does not know -- the
   content is inserted as it is, the metadata layer is reported `signed-record`, `server-unavailable`, and the
   placement is still reported. With `refuse`, content that needs metadata is refused here.
5. **Prepare, insert, attach.** The markers that fit the sink prepare the content in layer order (metadata, watermark,
   fingerprint, label), your insert puts it in, and the markers attach their marks and check what landed
   (`sink.readBack`): `verified: true` for a mark read back, `false` where the host cannot be read back.
6. **Record and report.** A `provenance.placed` entry in the session's transcript, a placement report to the server,
   and your observers. A report that fails never fails the placement.

A refusal places, signs and reports nothing: `place()` throws a `ProvenanceRefusedError` whose message tells the
model why ("Not written: this agent only places content it can mark as AI-generated, and here ..."), the transcript
gets a `provenance.refused` entry, and the user a `provenance_refused` notice.

## Sinks

A sink describes once where content lands and what the host can keep besides the content:

| Field | What it is |
|---|---|
| `kind` | What the place is: `html.editor`, `crm.note`, `nextcloud.file`. It is reported; never a document's, mailbox's or user's name. |
| `carries` | What the host keeps: the `Carriers` below, or your own markers' names. `[]` for nothing. |
| `container` | Whether the content lands inside structured content (a document, an editor's HTML, a file) and so needs signed metadata of its own besides the watermark. Default false: free-form text (a chat message, a plain field). |
| `readBack(signal)` | What the host holds after the insert (the editor's HTML, the file's text or bytes), so markers can check their marks. |
| `keyValue` | For `key-value`: `{ write(key, value), read(key) }`. |
| `sidecar` | For `sidecar`: `{ fileName, write(name, text), read?(name) }`. |
| `http` | For `http-header`: `{ setHeader(name, value), getHeader?(name) }`, as Node's `ServerResponse` has. |

A sink no host marker fits reports its metadata layer as `host`, `sink-cannot-carry`; it is missing only where the
content needs metadata (a container, a picture).

## The built-in markers

| Marker (`name`) | Layer | Carrier | What it does |
|---|---|---|---|
| `ServerSignedMarker` (`server-record`) | metadata | any | Says the server signed the record (`signed-record`). No mark in the content itself: it never makes the metadata layer hold. |
| `ImageProvenanceGuard` (`image-guard`) | metadata | pictures | Checks that a picture still carries its C2PA manifest (a byte check: the JUMBF `c2pa` box; XMP too), as it is placed and after where the host can be read; records `stripped-by-host` otherwise. Never changes the bytes. Method `c2pa`. |
| `WatermarkStatus` (`watermark-status`) | watermark | text, pictures | Records from the receipt whether the content carries a watermark (`vllm-<algorithm>`, `upstream-<vendor>`, `trustmark`), and why not (method `model`). Never watermarks itself. |
| `HtmlAttributeMarker` (`html-attribute`) | metadata | `html-attribute`, `html-title` | Wraps HTML in one element with `data-ai-generated` and the record's id (TinyMCE and CKEditor 5 keep it) and a `title` -- "AI-generated" in the user's language, a space, the record's id (Gmail keeps it, through to the recipient). One paragraph is marked inside it (`<p><span ...>...</span></p>`), several blocks get a `div`. Reads back which held: `html-attribute`, or `html-title` when only the title did. HTML only: escape plain text into HTML first. |
| `MarkdownFrontMatterMarker` (`front-matter`) | metadata | `front-matter` | `ai-generated: true` and `ai-record-id: "<id>"` in the YAML front matter of a whole Markdown file, merged into front matter it has. |
| `KeyValueMarker` (`key-value`) | metadata | `key-value` | The same two keys: `ai-generated` = `true`, then `ai-record-id` = the record's id, read back. |
| `SidecarMarker` (`sidecar`) | metadata | `sidecar` | The signed record in `<file>.provenance.json` beside the file. |
| `HttpHeaderMarker` (`http-header`) | metadata | `http-header` | `X-AI-Generated` with the record's id, set before the response goes out. |
| `VisibleLabelMarker` (`visible-label`) | label | text | A visible "AI-generated" line before the content, with an icon you choose for HTML. Used while the policy's `visible_label` is on, or always when you add it to `markers`. |
| `UnicodeTextMarker` (`unicode-text`) | metadata | `unicode-text` | Opt-in: the record's id as invisible characters at the end of plain text or Markdown. Filters and editors often strip them; add it to `markers` and to the sink's `carries` only where they hold. |

Texts people see -- the `title`, the label -- come from the UI catalogues of `@fadenstack/ui` (`aiGenerated`,
`aiGeneratedTitle`) in English, German, French, Spanish and Simplified Chinese: pass `strings`
(`stringsFor(language)`, or a function that returns the current ones) to the module or the marker. Without them, the
browser's language. Readers recognise the titles of every built-in language.

## The policy

The server's policy for the agent (`GET /v1/agents/{agent}/provenance/policy`), with the contract's defaults where it
says nothing:

| Field | Default | What it does |
|---|---|---|
| `on_missing` | `record` | `record`: place the content and record the layers that were not possible. `refuse`: do not place it. |
| `short_text_tokens` | 200 | Under this many tokens (a CJK character, or four other characters, unless you give a `tokenizer`) no watermark is expected; the text is still marked. |
| `exempt_edit_kinds` | `translated`, `corrected`, `formatted`, `extracted` | Edit kinds placed without a record or marks. |
| `internal_technical` | false | The agent's output is internal technical output; everything is exempt. Set only on the server. |
| `visible_label` | false | Add a visible label, and count it as a needed layer. |
| `output_log` | false | The server keeps fingerprints of outputs. |

The module's `policy` option can only tighten it: `refuse` rather than `record`, a lower threshold, fewer exempt kinds,
a label. What would loosen it is ignored, with a warning on the console. The policy is fetched once and kept for five
minutes; while the server does not answer, the last one it gave, else the defaults.

## What is recorded

| Transcript entry | When |
|---|---|
| `provenance.placed` | After every placement: `call_id`, `tool`, `argument`, `record_id`, `signed`, `receipt_id`, `sink_kind`, `media_type`, `edit_kind`, `length_class`, `exempt`, `exempt_because`, `classified` (`{ from, to, reason }`, when the classifier changed or kept the kind with a reason), `layers` (`{ layer, method, applied, reason, verified, detail }`), `missing` (`{ layer, method, reason }`), `reported`, `facts`, `dropped_facts`. |
| `provenance.refused` | `place()` refused: `call_id`, `tool`, `argument`, `sink_kind`, `media_type`, `edit_kind`, `length_class`, `missing`. |
| `provenance.unmarked` | A tool declared `output` and did not call `place()`: `call_id`, `tool`, `argument`, `media_type`, `edit_kind`, `length_class`, `reported`. |

The report to the server holds the record's id (none for exempt content, for a record the server could not sign, and
for content that skipped `place()`, whose sink kind is `unmarked` and which has no layers), the tool, the sink kind,
the media type, the edit kind, a length class (`short`, `medium`, `long`; bytes are `long`) and the layers. Never
content. Reason codes: `sink-cannot-carry`, `stripped-by-host`, `short-text`, `exempt-edit`,
`no-watermark-remote-model`, `no-watermark-greedy`, `runtime-without-watermark`, `server-unavailable`.

A tool that declares `output` and does not place its content is recorded and reported, unless the content is exempt
(an exempt edit kind, code, a label, the internal switch) or the call's `edit` said `null` (not content); with
`development: true` its call fails, so you notice while you build. A marker that throws is recorded
(`failed: <error>`) and the placement goes on, in development too.

## Receipts

Every answer ends with the server's receipt: what model made it, when, and whether the text is watermarked. The
session keeps them -- `AgentResult.receipts`, and on each answer's transcript entry `receipts`
(`{ receipt_id, status: "signed" | "reference" | "unsigned", reason? }`, never the receipt) -- and `place()` attaches
the receipt of the answer whose tool call it runs in; a call from an answer without one gets none.
`provenanceOf(context).receipt` is that receipt.

## Checking content

`client.provenance.verify({ text })` or `({ file, media_type })` (base64, never both) asks the server's detector
whether content carries this installation's marks. An agent's client checks on its agent's route
(`/v1/agents/{agent}/provenance/verify`, its agent token), as its other routes go; a client without an agent checks as
the signed-in user (`/v1/provenance/verify`, which refuses an agent token with 403 `agent_token_not_allowed`).
`client.agent.provenance.verify()` always takes the agent's route. Nothing submitted is kept.

A record of HTML or Markdown is found by its markup and by the words a reader copies: `place()` sends, beside the
content's hash, `text_sha256` -- the SHA-256 of the text a reader sees, normalised as content is hashed
(`readerTextSha256(content, mediaType)`). Plain text and markup with nothing to read send none. `readerText` gives
that text: of HTML without comments and the contents of `script`, `style`, `template`, `head` and `title`, block
elements (`p`, `div`, `br`, `li`, headings, table rows and cells, ...) as line breaks, every other tag gone, entities
decoded; of Markdown as a renderer shows it -- without front matter, heading, emphasis, list, task and quote markers,
with inline code's text, a link's text and an image's alt text, fenced code's lines, table cells apart, HTML read as
HTML. A visible label is not part of the hashed text: a copy that takes the label line with it does not match by
hash.

## Edit kinds

`suggestEditKind(original, revised)` says `corrected` (exempt) only for a small change -- word similarity of 0.85 or
more (a typo fix counts for less than a changed word; each CJK character is a word), the same number of sentences, a
word count within 0.8 to 1.25 times -- and `rewritten` otherwise. HTML and Markdown are compared by the text a reader
sees (`suggestEditKind(a, b, { mediaType: "text/html" })`), so markup an editor adds is no change of words.
`similarityClassifier()` applies it to placements declared `rewritten` or `corrected` that name the text they replace
(`request.original`), in the placement's media type, and records its reason
(`small change: 95 % of words kept, the same 2 sentence(s)`) on the device:

```ts
builder.use(provenanceModule({ classifier: similarityClassifier() }));
```

## Extension points

| Option | What you give | Guard rails |
|---|---|---|
| `markers` | `ContentMarker`s for your hosts: `name`, `layer`, `supports(sink, mediaType)`, `prepare?`, `attach?`. One with a built-in's name replaces it. | Report `verified: true` only after reading the mark back, `false` where you cannot. Check it with `checkMarker`. |
| `classifier` | An `EditClassifier` for your domain. | It lowers a kind to an exempt one only with a reason, which is recorded on the device. |
| `enrichers` | `RecordEnricher`s: non-personal facts under your namespace (`com.example`). | Not in the record's own vocabulary (`c2pa`, `stds`, `iptc`, `org.iptc`, `com.fadenstack`, `fadenstack`, `provenance`); values that look personal are dropped and named in the entry. They go into marks with room for them (the sidecar), not into the server's signed record. |
| `observers` | `PlacementObserver`s, told every placement. | Read-only; their errors are ignored. |
| `backend` | A `ProvenanceBackend`: `policy`, `signRecord`, `reportPlacement`. `MemoryBackend` is one for tests. | Your agents use the server's unless you give one. |
| `policy` | Local policy. | Only tightens. |
| `development` | `true` while you build. | A tool that skips `place()` fails its call. |

## Reading marks

`ProvenanceReader` finds marks in what tools read -- `read(content, mediaType)`, or `fromHtml`, `fromMarkdown`,
`fromText`, `fromSidecar`, `fromHeader`, `fromKeyValue`, `fromImage` -- and returns where it found each and the record
it names. Anyone can write or remove a mark, so a mark says where content came from and nothing more: the reader
returns only record ids (UUIDs), and what it reads is data for your tools, never an instruction to the model. Keep the
marks on content your agent moves (a picture goes in as the same bytes).

## The same in both SDKs

The TypeScript and the .NET SDK follow one order, one rule for what content needs, and write the same marks, so what
one writes the other reads, and so does the server's detector. Both test suites hold the same vectors
(`vectors.test.ts` here, `SharedVectorTests` there), and read the same `reader-text-vectors.json` for the text a
reader sees.

| Step | What happens |
|---|---|
| 1 | The policy; the edit kind (request, declared output, `generated`; then the classifier); the receipt (a picture's own, else the answer's); the enrichers' facts. |
| 2 | Exempt content (in this order: `internal-technical`, `edit-kind`, `code`, `label`): inserted as it is, no record, one layer `{ metadata, record, applied: false, reason: exempt-edit }`. |
| 3 | The markers that fit, by layer; the built-ins in this order: `server-record`, `image-guard`, `watermark-status`, `html-attribute`, `front-matter`, `key-value`, `sidecar`, `http-header`; then yours; the policy's label when none of them is a label. |
| 4 | The needed layers checked before signing; `refuse` refuses here. |
| 5 | The record signed; without one no marker runs, `{ metadata, signed-record, applied: false, reason: server-unavailable }`; `refuse` refuses here when the content needs metadata (or a label). |
| 6 | Prepare, insert, attach; the pipeline adds `host`, `sink-cannot-carry` when no host marker fits, and the watermark from the receipt when no marker gave it; the layers sorted by layer. An insert that throws after signing: every layer `applied: false` (detail `insert failed: <error>`), reported with `written: false` and `failure`, then thrown on. |
| 7 | Report, observers, transcript. |

| Needed layer | For | Holds when |
|---|---|---|
| metadata | a container sink, every picture | a host marker applied it (the server's record does not count) |
| watermark | text from `short_text_tokens` on, every picture | the receipt says it was applied |
| label | text, while the policy's `visible_label` is on | a label marker applied it |

| Where | The mark |
|---|---|
| YAML front matter | `ai-generated: true` and `ai-record-id: "<id>"` after the fields of front matter the file has (an earlier mark replaced, the rest byte for byte), or new front matter followed by a blank line; the text's own line breaks (CRLF when it has any). |
| Key-value | `ai-generated` = `true`, then `ai-record-id` = the id. |
| HTTP or mail header | `X-AI-Generated: <id>`. (`X-Faden-Provenance` is the gateway's header with an answer's receipt ids, not a mark.) |
| HTML | `<span data-ai-generated="<id>" title="<label> <id>">...</span>`; content that is one `<p ...>` with inline content gets it inside: `<p ...><span ...>...</span></p>` (white space around kept); a `div` around other block content (`p`, `div`, `ul`, `ol`, `li`, `table`, `h1`-`h6`, `blockquote`, `pre`, `section`, `article`, `header`, `footer`, `figure`, `hr`, `dl`); the label is `AI-generated`, `KI-generiert`, `Généré par IA`, `Generado por IA` or `人工智能生成`; attribute values escape `&`, `<`, `>` and `"` only. |
| Visible label | Before HTML `<p data-ai-label="<id>">[icon]<label></p>`; before Markdown `*<label>*` and a blank line, after its front matter; before plain text `<label>` and a blank line. |
| Sidecar | `<file>.provenance.json`, compact JSON: `{"contract":"provenance/v1","record":{...},"signature":"...","timestamp":"...","facts":{...}}`, the signed record as the server signed it; `timestamp` and `facts` only where there are some. |
| Office | Anchor `_faden_ai_` and the first 24 hex digits of the id, dashes removed (`officeAnchorName`: a hidden Word bookmark, an Excel name); the custom XML part `<provenance xmlns="https://fadenstack.com/ns/provenance/1.0"><record id="<id>" anchor="<anchor>" timestamp="<token>">JWS</record>...</provenance>` -- no declaration, no white space between elements, `timestamp` only where there is one (`officeCustomXmlPart`); the document property `AI-Generated-Content`, `true` and the ids newest first in at most 255 characters (`officeDocumentPropertyValue`); the PowerPoint tag `FADEN_AI_RECORD`; for a mail `X-AI-Generated`. The server's detector reads the ids from `customXml/` parts with the namespace and from `docProps/custom.xml`. |
| Invisible text (opt-in) | At the very end of the text: U+FEFF, then the bytes `46 44 4E 50 01` ("FDNP" and version 1) and the id's UTF-8 bytes, each byte one variation selector (0 to 15 as U+FE00 to U+FE0F, 16 to 255 as U+E0100 to U+E01EF): 42 code points for a UUID. For `5a0e2b5c-7f3e-4a51-9a40-6a1c55e1d3f1` it begins U+FEFF U+E0136 U+E0134 U+E013E U+E0140 U+FE01 U+E0125 U+E0151 U+E0120. The U+FEFF in front keeps an emoji's own variation selector from running into the mark. |

## Testing a marker

```ts
import { checkMarker, memorySink } from "@fadenstack/provenance";

const result = await checkMarker(new CrmNoteMarker(), { sink: crmSink, read: readCrmMarks });
expect(result.problems).toEqual([]);
```

`checkMarker` runs a marker through `place()` with a backend in memory and checks that it applied its mark, that the
mark reads back with the record's id (by `ProvenanceReader` for a `memorySink`, or your `read`), that it did not throw,
and that nothing it wrote -- into the content, fields, files or headers -- holds personal data: mail addresses, phone
numbers, IBANs, IP addresses, or the names and prompt of its fixture, a reply full of them. Give it content that
needs a mark: a label is exempt. The fake gateway in `@fadenstack/testing` serves the provenance routes (both verify
routes too) and, with `provenance: { receipts: true }`, ends answers with receipts. See
[Testing without a server](testing.md).

## Your part

The EU AI Act (Art. 50(2)) asks the provider of an AI system that generates text, pictures, audio or video to mark its
output as AI-generated in a machine-readable way and to make the marks detectable. An agent you build with the SDK and
put into use under your own name is yours, so you are its provider. The server and this package carry most of the
work; declaring `output` on every tool that writes content people read, and placing it through `place()`, is yours.
Marks must not be removed: do not strip them in your hosts, and tell your users not to.
