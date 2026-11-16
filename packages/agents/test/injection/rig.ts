import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { EndpointDialect, type ToolClass, type ToolMode } from "@fadenstack/client";
import {
  AgentDefinition,
  ApprovalDecision,
  FadenstackAgent,
  MemoryApprovalStore,
  MemorySessionStore,
  MemoryWebSearchStore,
  defineTool,
  fenceUntrusted,
  webSearchModule,
  type ApprovalRequest,
} from "@fadenstack/agents";
import { OpenAiFake } from "@fadenstack/testing";
import { MemoryMcpServerStore, mcpModule } from "@fadenstack/mcp";

import { FakeMcpServer } from "../../../mcp/test/fakeServer.js";

// The injection suite's rig (sdk/51 7.1). .NET: tests/Fadenstack.Agents.Tests/Injection/InjectionRig.cs.
// Injected content runs through a channel on a scripted endpoint: the model calls the channel's tool, sees the content in its
// result, and then (when the case induces a call) sends the call the content asks for. The approval handler approves the channel's
// own tool and denies everything else, so a call that asks never runs.

/** The SHA-256 of corpus.json with line endings as LF. The .NET SDK holds the same constant. */
export const CORPUS_SHA256 = "34118260aa6c052ea505c97bbdbe60d0c210ed3d0219223b75211e94d439e334";

/** The call the content asks for, as the scripted model sends it. */
export interface Induced {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

export interface InjectionCase {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  /** The content, with its padding already put in front. */
  readonly content: string;
  readonly induces?: Induced;
}

const CORPUS = new URL("./corpus.json", import.meta.url);

export function corpusSha256(): string {
  const text = readFileSync(CORPUS, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function loadCorpus(): InjectionCase[] {
  const file = JSON.parse(readFileSync(CORPUS, "utf8")) as {
    cases: { id: string; title: string; kind: string; content: string; padding?: { unit: string; times: number }; induces?: Induced }[];
  };
  return file.cases.map((c) => ({
    id: c.id,
    title: c.title,
    kind: c.kind,
    content: (c.padding ? c.padding.unit.repeat(c.padding.times) : "") + c.content,
    ...(c.induces ? { induces: c.induces } : {}),
  }));
}

/** The app's tool contract: the classes the tools declare, vouched for (without it a tool is "unknown" and always asks). */
const CONTRACT = [
  { name: "read_document", risk: "read" }, { name: "post_comment", risk: "write" }, { name: "delete_page", risk: "destructive" },
  { name: "fetch_url", risk: "read" },
];

export const BENIGN = "The quarterly figures are on page 2. Nothing else to report.";

/** The channels the TypeScript SDK has. (There is no delegation tool in this SDK: the .NET suite also runs delegation answers.) */
export type Channel = "mcp" | "web" | "document";
export const CHANNELS: readonly Channel[] = ["mcp", "web", "document"];

export const MODES: readonly ToolMode[] = ["read_only", "ask", "auto"];

export const channelTool = (channel: Channel): string => ({ mcp: "read_note", web: "web_search", document: "read_document" })[channel];

/** The fence kind each channel's result opens with. */
export const fenceKind = (channel: Channel): string => ({ mcp: "mcp-result", web: "web-results", document: "untrusted-document" })[channel];

/** Whether the channel's tool is offered in the mode (an MCP tool has no class: read_only hides it). */
export const reachable = (channel: Channel, mode: ToolMode): boolean => (channel === "mcp" ? mode !== "read_only" : true);

export const classOf = (tool: string): ToolClass => (tool === "post_comment" ? "write" : tool === "delete_page" ? "destructive" : "read");

/** What a scripted run saw. */
export interface InjectionRun {
  /** What the model received of the channel's tool: its result. */
  readonly received: string;
  /** The tools that really ran, in order. */
  readonly ran: readonly string[];
  /** The approvals asked for any tool but the channel's own (all denied). */
  readonly asked: readonly ApprovalRequest[];
  /** The tools the model was offered in the request after the channel's tool answered. */
  readonly offered: readonly string[];
  readonly outcome: string;
}

export async function run(channel: Channel, content: string, mode: ToolMode, induces?: Induced): Promise<InjectionRun> {
  const ran: string[] = [];
  const asked: ApprovalRequest[] = [];
  const tool = channelTool(channel);

  const postComment = defineTool<{ text: string }>({
    name: "post_comment", description: "Posts a comment.", toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: () => { ran.push("post_comment"); return "posted"; },
  });
  const deletePage = defineTool<{ page: number }>({
    name: "delete_page", description: "Deletes a page.", toolClass: "destructive",
    parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    run: () => { ran.push("delete_page"); return "deleted"; },
  });
  const fetchUrl = defineTool<{ url: string }>({
    name: "fetch_url", description: "Fetches a web address.", toolClass: "read", openWorld: true,
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: () => { ran.push("fetch_url"); return "fetched"; },
  });
  const readDocument = defineTool<Record<string, never>>({
    name: "read_document", description: "Reads the open document.", toolClass: "read",
    parameters: { type: "object", properties: {} },
    run: () => { ran.push("read_document"); return fenceUntrusted({ label: "document", origin: "the Word document Report.docx", body: content }); },
  });

  const model = new OpenAiFake();
  const builder = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: model.fetch })
    .useLocalProfile(AgentDefinition.fromJson({
      slug: "docs-assistant", name: "Docs assistant",
      version: { instructions: "You are the docs assistant.", host_tool_contract: CONTRACT },
    }), undefined, { localMcp: channel === "mcp" })
    .useSessionStore(new MemorySessionStore())
    .useApprovalStore(new MemoryApprovalStore())
    .addTools(postComment, deletePage, fetchUrl, ...(channel === "document" ? [readDocument] : []))
    .useApprovals((request) => {
      if (request.toolName === tool || request.toolName === "find_tool") return Promise.resolve(ApprovalDecision.approve()); // the channel's own tools
      asked.push(request);
      return Promise.resolve(ApprovalDecision.deny("The person declined."));
    });

  if (channel === "mcp") {
    const fake = new FakeMcpServer({ tools: [{ name: "read_note", description: "Reads a note.", readOnlyHint: true, answer: () => content }] });
    const store = new MemoryMcpServerStore();
    await store.save({ label: "notes-db", url: fake.urls.both, headers: {}, enabled: true, trusted: false, toolClasses: {}, reviewed: true });
    builder.use(mcpModule({ store, fetch: fake.fetch as typeof fetch }));
  } else if (channel === "web") {
    const store = new MemoryWebSearchStore();
    await store.save({ provider: "brave" });
    await store.setBraveKey("BSA-test-key-0123456789");
    const fetchProvider = (async () => Response.json({
      web: { results: [{ title: "Quarterly report", url: "https://docs.example.com/report", description: content }] },
    })) as unknown as typeof globalThis.fetch;
    builder.use(webSearchModule({ store, fetch: fetchProvider }));
  }

  // The script: (find the MCP tool,) call the channel's tool, (call the induced tool,) answer.
  if (channel === "mcp") model.answers.push(OpenAiFake.calls(["call-0", "find_tool", JSON.stringify({ query: "read note" })]));
  const channelArguments = channel === "web" ? { query: "quarterly report" } : channel === "mcp" ? { text: "x" } : {};
  model.answers.push(OpenAiFake.calls(["call-1", tool, JSON.stringify(channelArguments)]));
  if (induces) model.answers.push(OpenAiFake.calls(["call-2", induces.tool, JSON.stringify(induces.arguments)]));
  model.answers.push(OpenAiFake.text("Done."));

  const agent = builder.build();
  try {
    const result = await (await agent.startSession(mode)).send("Please read it.");
    // The request after the channel's tool answered: what the model received, and the tools it is offered.
    const requests = model.requests.filter((r) => r.url.pathname.endsWith("/chat/completions")).map((r) => r.json());
    const request = requests[channel === "mcp" ? 2 : 1];
    const messages = (request?.["messages"] ?? []) as { role: string; content: unknown }[];
    const received = String(messages.filter((m) => m.role === "tool").at(-1)?.content ?? "");
    const offered = ((request?.["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    return { received, ran, asked, offered, outcome: String(result.outcome) };
  } finally {
    await agent.dispose();
  }
}
