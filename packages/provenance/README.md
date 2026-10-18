# @fadenstack/provenance

Marks content an agent's tools place as made with AI, where it lands: a reply in a web editor, a note in a CRM, a
Markdown file, a picture in a slide. It works with a [Fadenstack](https://fadenstack.com) server, which watermarks
text as the model writes it, marks pictures as it makes them, signs a record of every placement, and runs the
detector. This package is the device's part: it places content through one pipeline, puts a mark in or beside it
where the host can keep one, and records and reports which marks held and why the others did not.

```bash
npm install @fadenstack/client @fadenstack/agents @fadenstack/provenance
```

```ts
import { FadenstackAgent, defineTool } from "@fadenstack/agents";
import { provenanceModule, provenanceOf, type SinkInfo } from "@fadenstack/provenance";

const editorSink: SinkInfo = {
  kind: "html.editor",
  carries: ["html-attribute", "html-title"],
  readBack: () => editor.getHTML(), // so the marks are checked after the insert
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

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(insertReply)
  .use(provenanceModule())
  .build();
```

`place()` asks the server to sign a record of the placement by the content's hash (never the content), lets the
markers that fit the sink prepare the content (here: a `span` with `data-ai-generated` and a `title` saying
"AI-generated" in the user's language), calls your insert, lets the markers check what landed, and reports the
placement. Translations, corrections, formatting, extracts, code and text under 200 tokens are exempt: they are placed
as they are and recorded as exempt. With the agent's policy set to `refuse`, content is not placed at all when a mark
it needs is not possible, and the tool tells the model why.

## How much your host does

A host that keeps no mark still gets the two layers that matter most: the model's watermark in the words, and the
signed record on the server, which the detector finds by the content's hash. What a host adds is a mark of its own.

| Level | You | You get |
|---|---|---|
| **0** | Declare `output` on the tool and call `place()` with a sink that carries nothing (`carries: []`). | The watermark and the server's record; the placement records `sink-cannot-carry`, and the policy decides (`record` by default, `refuse` per agent). |
| **1** | Give the SDK one place to keep a string: a `KeyValueSink` (a hidden CRM field, a ticket's custom field, an object's metadata). | `KeyValueMarker` writes the record's id there, reads it back, and records what held. |
| **2** | Say which format the host stores. | The built-in marker for it: `HtmlAttributeMarker`, `MarkdownFrontMatterMarker`, `SidecarMarker`, `HttpHeaderMarker`. |
| **3** | Write a `ContentMarker` for a host nothing else fits. | Full control in `prepare` and `attach`; the test kit checks it. |

### Level 1: a CRM note with one hidden field

```ts
import type { KeyValueSink, SinkInfo } from "@fadenstack/provenance";

const crmField: KeyValueSink = {
  write: (key, value) => crm.notes.setCustomField(noteId, key, value),
  read: (key) => crm.notes.getCustomField(noteId, key),
  maxLength: 255, // the signed record goes in only where it fits; the record's id otherwise
};
const sink: SinkInfo = { kind: "crm.note", carries: ["key-value"], keyValue: crmField };

await provenanceOf(context).place({ content: text, mediaType: "text/plain", sink }, (marked) =>
  crm.notes.update(noteId, String(marked.content)));
```

### Level 3: a marker of your own

```ts
import type { ContentMarker, MarkOutcome, PlacedContent, ProvenanceRecord, SinkInfo } from "@fadenstack/provenance";

class CrmNoteMarker implements ContentMarker {
  readonly name = "crm-note";
  readonly layer = "metadata";

  supports(sink: SinkInfo): boolean {
    return sink.kind === "crm.note" && sink.carries.includes("crm-note");
  }

  async attach(_placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    await crm.notes.tag(noteId, `ai-generated:${record.id}`); // the record's id, never content or a name
    const tags = await crm.notes.tags(noteId);
    return tags.includes(`ai-generated:${record.id}`)
      ? { applied: true, method: "crm-note" }
      : { applied: false, method: "crm-note", reason: "stripped-by-host" };
  }
}

builder.use(provenanceModule({ markers: [new CrmNoteMarker()] }));
```

Check it with the test kit: it runs the marker through `place()` with a backend in memory, reads the mark back, and
fails on personal data in anything the marker wrote.

```ts
import { checkMarker } from "@fadenstack/provenance";

const result = await checkMarker(new CrmNoteMarker(), {
  sink: { kind: "crm.note", carries: ["crm-note"] },
  read: async () => (await crm.notes.tags(noteId)).map((t) => ({ carrier: "crm-note", recordId: t.split(":")[1] })),
});
expect(result.problems).toEqual([]);
```

## Your part

The EU AI Act (Art. 50(2)) asks the provider of an AI system that generates text, pictures, audio or video to mark
its output as AI-generated in a machine-readable way and to make the marks detectable. An agent you build with the
SDK and put into use under your own name is yours, so you are its provider. This package and the server carry most
of the work; declaring `output` on every tool that writes content people read, and placing it through `place()`, is
yours. Marks must not be removed: do not strip them in your hosts, and tell your users not to.

- Documentation: <https://developers.fadenstack.com/sdk/typescript/provenance/>
- Source and issues: <https://github.com/fadenstack/fadenstack-sdk-typescript>
