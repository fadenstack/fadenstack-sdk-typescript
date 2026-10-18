import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, type AgentSession, type AgentTool, type TranscriptEntry } from "@fadenstack/agents";
import { provenanceModule, type ProvenanceOptions, type SinkInfo } from "@fadenstack/provenance";
import { FakeGateway, lastToolResults, type FakeAgent, type FakeGatewayOptions } from "@fadenstack/testing";

/** About 235 tokens: long enough to be marked under the default threshold of 200. */
export const LONG = "The delivery for order 4711 arrives on Friday, and the missing part comes with it. ".repeat(11).trim();

/** A web editor (a container: its HTML carries metadata) that keeps everything inserted, or drops `data-` attributes as Gmail does. */
export class Editor {
  html = "";
  readonly sink: SinkInfo;
  readonly #dropsDataAttributes: boolean;

  constructor(dropsDataAttributes = false, carries: readonly string[] = ["html-attribute", "html-title"]) {
    this.#dropsDataAttributes = dropsDataAttributes;
    this.sink = { kind: "html.editor", container: true, carries, readBack: () => this.html };
  }

  insert(html: string): string {
    this.html += this.#dropsDataAttributes ? html.replace(/\sdata-[\w-]+="[^"]*"/g, "") : html;
    return "inserted";
  }
}

export interface Run {
  gateway: FakeGateway;
  agent: FadenstackAgent;
  session: AgentSession;
  /** The last tool result, as the model got it. */
  toolResult(): string;
  entries(type: string): TranscriptEntry[];
}

/**
 * An agent with `tools` (all in its contract as write tools) and the provenance module, on a fake gateway that sends
 * receipts; its model calls `call.tool` with `call.args` once, then answers. `send` runs one turn.
 */
export async function run(
  tools: AgentTool[],
  call: { tool: string; args: Record<string, unknown> },
  options: { gateway?: FakeGatewayOptions; agent?: Partial<FakeAgent>; module?: ProvenanceOptions; withoutModule?: boolean } = {},
): Promise<Run> {
  const gateway = new FakeGateway({
    agents: [{ slug: "writer", contract: tools.map((t) => ({ name: t.name, risk: "write" as const })), ...options.agent }],
    provenance: { receipts: true, ...options.gateway?.provenance },
    model: (request) => (lastToolResults(request).size ? { text: "Done." } : { text: "", toolCalls: [{ name: call.tool, arguments: call.args }] }),
    ...options.gateway,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "writer", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  let builder = FadenstackAgent.createBuilder()
    .useClient(client)
    .addTools(...tools)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(async () => ({ approved: true }));
  if (!options.withoutModule) builder = builder.use(provenanceModule(options.module));
  const agent = builder.build();
  const session = await agent.startSession("auto");
  return {
    gateway, agent, session,
    toolResult: () => String(session.transcript.filter((e) => e.type === "tool.execution_complete" && e.data["origin"] === "client")
      .at(-1)?.data["result"] ?? ""),
    entries: (type) => session.transcript.filter((e) => e.type === type),
  };
}

/** Pretend PNG bytes with a C2PA manifest store (JUMBF, label c2pa) and an XMP packet: what the byte check looks for. */
export function markedPicture(c2pa = true, xmp = true): Uint8Array {
  const parts = ["\x89PNG\r\n\x1a\n", "IHDRfake"];
  if (c2pa) parts.push("caBX", "\x00\x00\x00\x40jumb\x00\x00\x00\x1ejumdc2pa\x00\x11\x00\x10", "c2pa.manifest");
  if (xmp) parts.push("iTXtXML:com.adobe.xmp", '<x:xmpmeta xmlns:x="adobe:ns:meta/"><Iptc4xmpExt:DigitalSourceType>'
    + "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType></x:xmpmeta>");
  parts.push("IDATpixelsIEND");
  return Uint8Array.from(parts.join(""), (c) => c.charCodeAt(0));
}
