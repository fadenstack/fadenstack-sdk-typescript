import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  type LocalProfileOptions,
} from "@fadenstack/agents";
import { FakeGateway, OpenAiFake, type FakeAgent, type FakeReply } from "@fadenstack/testing";
import { skillsModule, type SkillDefinition, type SkillsModule, type SkillsOptions } from "@fadenstack/skills";

/** The agent's own instructions in every test. */
export const BASE = "You are the docs assistant.";

const DEFINITION = { slug: "docs-assistant", name: "Docs assistant", version: { instructions: BASE } };
const LOCAL = "http://localhost:11434/v1";

/** The standard skill of the tests (the .NET tests' `SkillFolders.Standard`): the six fields, a body and a resource. */
export const HOUSE_BODY = "Always greet the customer by name, then answer in two short paragraphs.";
export const HOUSE_RESOURCE = "Keep the tone warm and never use the word 'unfortunately'.";

export function standard(name = "house-style", description = "Writes customer replies in the house style.", more: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description,
    license: "Apache-2.0",
    compatibility: "any",
    metadata: { author: "tests" },
    allowedTools: "read_page",
    body: `# House style\n${HOUSE_BODY}\n`,
    resources: { "references/tone.md": HOUSE_RESOURCE },
    ...more,
  };
}

/** One model call as the endpoint saw it. */
export interface ModelCall {
  tools: string[];
  /** The system message the call started with, if any (the agent's instructions, then the skills'). */
  instructions: string | undefined;
  messages: { role: string; content: unknown }[];
  /** The text of every tool message, in order. */
  toolResults: string[];
}

export function calls(fake: OpenAiFake): ModelCall[] {
  return fake.requests.filter((r) => r.url.pathname.endsWith("/chat/completions")).map((r) => {
    const json = r.json();
    const messages = json["messages"] as { role: string; content: unknown }[];
    const tools = ((json["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    const first = messages[0];
    return {
      tools,
      instructions: first?.role === "system" ? String(first.content) : undefined,
      messages,
      toolResults: messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
    };
  });
}

/** A log that keeps what it is told. */
export class Entries implements FadenstackLogger {
  readonly lines: LogEvent[] = [];
  log(event: LogEvent): void {
    this.lines.push(event);
  }
  /** The skills module's warnings (the agent's own note that it runs without the provenance module is not about skills). */
  get warnings(): LogEvent[] {
    return this.lines.filter((l) => l.level === "warning" && l.category === "Fadenstack.Skills");
  }
}

export interface Rig {
  readonly fake: OpenAiFake;
  readonly module: SkillsModule | undefined;
  readonly asked: string[];
  readonly builder: AgentBuilder;
}

export interface RigOptions {
  skills?: SkillsOptions | undefined;
  logs?: Entries;
  policy?: MachinePolicy;
  local?: LocalProfileOptions;
  mode?: ToolMode;
  /** Add the module itself (a test that keeps it). */
  module?: SkillsModule;
  /** No module at all. */
  without?: boolean;
}

/** A standalone agent on a scripted endpoint, with a skills module over memory (no IndexedDB unless a test gives a store). */
export function standalone(options: RigOptions = {}): Rig {
  const fake = new OpenAiFake();
  const asked: string[] = [];
  const builder = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: LOCAL, model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
    .useLocalProfile(AgentDefinition.fromJson(DEFINITION), undefined, options.local)
    .useSessionStore(new MemorySessionStore())
    .useApprovalStore(new MemoryApprovalStore())
    .useApprovals((request) => {
      asked.push(request.toolName);
      return Promise.resolve(ApprovalDecision.approve());
    });
  if (options.logs) builder.useLogging(options.logs);
  if (options.policy) builder.useMachinePolicy(options.policy);
  if (options.mode) builder.useDefaultToolMode(options.mode);
  const module = options.module ?? (options.without ? undefined : skillsModule({ store: false, ...options.skills, ...(options.logs ? { logger: options.logs } : {}) }));
  if (module) builder.use(module);
  return { fake, module, asked, builder };
}

/** Sends one message to a new session of the rig's agent. */
export async function ask(rig: Rig, message: string): Promise<void> {
  const agent = rig.builder.build();
  try {
    await (await agent.startSession()).send(message);
  } finally {
    await agent.dispose?.();
  }
}

/** Plays the endpoint's answers: a tool call, then a text. */
export function call(name: string, args: Record<string, unknown>, id = "call-1") {
  return OpenAiFake.calls([id, name, JSON.stringify(args)]);
}

/** A signed-in agent on a fake server (governed): the module is added to it. */
export async function governed(agent: Partial<FakeAgent>, module: SkillsModule, reply?: FakeReply, configure?: (b: AgentBuilder) => AgentBuilder) {
  const gateway = new FakeGateway({ agents: [{ slug: "docs", ...agent }], model: () => reply ?? { text: "Hello." } });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
    .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).use(module);
  const agentUnderTest = (configure ? configure(builder) : builder).build();
  return { gateway, agent: agentUnderTest };
}

/** The slide-design skill of the Office agent (the fixture), as a skill: its frontmatter's two fields, its body, its faden.yaml. */
export function slideDesign(withYaml = true): SkillDefinition {
  const directory = new URL("./fixtures/slide-design/", import.meta.url);
  const text = readFileSync(fileURLToPath(new URL("SKILL.md", directory)), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("The fixture has no frontmatter.");
  const field = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(match[1]!)![1]!;
  const skill: SkillDefinition = { name: field("name"), description: field("description"), body: match[2]! };
  return withYaml ? { ...skill, fadenYaml: slideDesignYaml() } : skill;
}

export function slideDesignYaml(): string {
  return readFileSync(fileURLToPath(new URL("./fixtures/slide-design/faden.yaml", import.meta.url)), "utf8");
}
