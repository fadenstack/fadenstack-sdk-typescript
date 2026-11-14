import {
  EndpointDialect,
  FadenstackClient,
  loginWithPassword,
  type FadenstackLogger,
  type LogEvent,
  type ToolMode,
} from "@fadenstack/client";
import {
  AgentDefinition,
  ApprovalDecision,
  FadenstackAgent,
  MachinePolicy,
  MemoryApprovalStore,
  MemorySessionStore,
  type AgentBuilder,
} from "@fadenstack/agents";
import { FakeGateway, OpenAiFake, type FakeAgent, type FakeReply } from "@fadenstack/testing";
import { MemoryMcpServerStore, mcpModule, type McpModule, type McpOptions, type McpServerRecord } from "@fadenstack/mcp";

import { FakeMcpServer } from "./fakeServer.js";

const DEFINITION = { slug: "docs-assistant", name: "Docs assistant", version: { instructions: "You are the docs assistant." } };
const LOCAL = "http://localhost:11434/v1";

/** A log that keeps what it is told. */
export class Entries implements FadenstackLogger {
  readonly lines: LogEvent[] = [];
  log(event: LogEvent): void {
    this.lines.push(event);
  }
  /** What the MCP module logged. */
  get mcp(): LogEvent[] {
    return this.lines.filter((l) => l.category === "Fadenstack.Mcp");
  }
}

/** A record as the person's list holds it, switched on. */
export function server(label: string, url: string, more: Partial<McpServerRecord> = {}): McpServerRecord {
  return { label, url, headers: {}, enabled: true, trusted: false, toolClasses: {}, reviewed: true, ...more };
}

export interface Rig {
  readonly fake: OpenAiFake;
  readonly module: McpModule;
  readonly store: MemoryMcpServerStore;
  readonly asked: string[];
  readonly logs: Entries;
  readonly builder: AgentBuilder;
}

export interface RigOptions {
  mcp?: McpOptions | undefined;
  policy?: MachinePolicy;
  /** The person's own setting: local MCP on (default) or off. */
  localMcp?: boolean;
  mode?: ToolMode;
}

/** A standalone agent on a scripted endpoint, with an MCP module over a memory store and the fake server's `fetch`. */
export function standalone(fake: FakeMcpServer, options: RigOptions = {}): Rig {
  const model = new OpenAiFake();
  const asked: string[] = [];
  const logs = new Entries();
  const store = new MemoryMcpServerStore();
  const builder = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: LOCAL, model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: model.fetch })
    .useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, { localMcp: options.localMcp ?? true })
    .useSessionStore(new MemorySessionStore())
    .useApprovalStore(new MemoryApprovalStore())
    .useLogging(logs)
    .useApprovals((request) => {
      asked.push(request.toolName);
      return Promise.resolve(ApprovalDecision.approve());
    });
  if (options.policy) builder.useMachinePolicy(options.policy);
  if (options.mode) builder.useDefaultToolMode(options.mode);
  const module = mcpModule({ store, fetch: fake.fetch as typeof fetch, logger: logs, ...options.mcp });
  builder.use(module);
  return { fake: model, module, store, asked, logs, builder };
}

/** Sends one message to a new session of the rig's agent; the agent is returned for a look at its tools. */
export async function ask(rig: Rig, message: string): Promise<FadenstackAgent> {
  const agent = rig.builder.build();
  await (await agent.startSession()).send(message);
  return agent;
}

/** One model call as the endpoint saw it. */
export interface ModelCall {
  tools: string[];
  toolResults: string[];
}

export function calls(model: OpenAiFake): ModelCall[] {
  return model.requests.filter((r) => r.url.pathname.endsWith("/chat/completions")).map((r) => {
    const json = r.json();
    const messages = json["messages"] as { role: string; content: unknown }[];
    return {
      tools: ((json["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name),
      toolResults: messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
    };
  });
}

/** Plays the endpoint's answer: a tool call. */
export function call(name: string, args: Record<string, unknown>, id = "call-1") {
  return OpenAiFake.calls([id, name, JSON.stringify(args)]);
}

/** A signed-in agent on a fake server (governed), the module added to it. */
export async function governed(agent: Partial<FakeAgent>, module: McpModule, reply?: FakeReply, configure?: (b: AgentBuilder) => AgentBuilder) {
  const gateway = new FakeGateway({ agents: [{ slug: "docs", ...agent }], model: () => reply ?? { text: "Hello." } });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
    .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).use(module);
  const built = (configure ? configure(builder) : builder).build();
  return { gateway, agent: built };
}
