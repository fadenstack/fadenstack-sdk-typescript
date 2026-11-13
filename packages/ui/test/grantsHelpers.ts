import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, GrantPlace, MemorySessionStore, defineTool, type StepUpRequest, type StepUpStage } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { FakeGateway, type FakeGatewayOptions, type FakeGrants } from "@fadenstack/testing";
import { testServices } from "./services.js";

/** What a 0.7 server offers an agent that announced Bypass: up to an hour, the second sign-in, calls as evidence. */
export const OFFERED: Record<string, unknown> = {
  standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"],
  bypass: { allowed: true, longest_minutes: 60, evidence: "calls", step_up: { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" } },
};

export const MIN = 60_000;
export const REPORT = GrantPlace.document("C:\\Docs\\report.docx");
export const BUDGET = GrantPlace.document("C:\\Docs\\budget.xlsx");

/** The value once `find` returns one (polled; the agent runs on its own). */
export async function waitFor<T>(find: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > until) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

export interface GrantChatOptions {
  approvals?: Record<string, unknown>;
  gateway?: FakeGatewayOptions;
  chat?: Partial<AgentChatOptions>;
  maxLevel?: string;
  ceiling?: string;
  /** Another view model over the same agent and broker, as a second chat panel. */
  broker?: ApprovalBroker;
}

/** A chat over an agent on a fake server that holds grants and offers Bypass, with a clock the test moves. */
export async function grantChat(options: GrantChatOptions = {}) {
  const gateway = new FakeGateway({
    agents: [{
      slug: "docs", name: "Docs assistant", maxLevel: options.maxLevel ?? "bypass",
      ...(options.ceiling ? { ceiling: options.ceiling as never } : {}),
      contract: [{ name: "read_page", risk: "read" }, { name: "write_page", risk: "write" }],
    }],
    grants: { approvals: options.approvals ?? OFFERED },
    ...options.gateway,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const broker = options.broker ?? new ApprovalBroker();
  const opened: URL[] = [];
  broker.openBrowser = (link) => { opened.push(link); return true; };
  const stages: [StepUpRequest, StepUpStage][] = [];
  broker.onStepUpChanged((request, stage) => stages.push([request, stage]));
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(broker)
    .useGrantPlaceResolver(async (place) => place)
    .addTools(
      defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." }),
      defineTool<{ text: string }>({ name: "write_page", toolClass: "write", parameters: { type: "object", properties: { text: { type: "string" } } }, run: () => "written" }),
    )
    .build();
  agent.stepUps.delay = () => Promise.resolve();
  const grants: FakeGrants = gateway.grants!;
  const clock = { now: Date.UTC(2026, 10, 12, 9, 0, 0) };
  agent.clock = () => clock.now;
  grants.serverNow = clock.now;
  const advance = (ms: number) => { clock.now += ms; grants.serverNow = clock.now; };
  const chat = new AgentChatViewModel(agent, broker, {
    ...testServices(), scheduler: immediateScheduler, grantTickMs: 0,
    ...options.chat,
  });
  await chat.initialize();
  return { gateway, grants, broker, agent, chat, opened, stages, clock, advance };
}

export type GrantChat = Awaited<ReturnType<typeof grantChat>>;

/** Sends a first message, so the chat has a conversation to offer cards for. */
export async function conversation(s: GrantChat) {
  await s.chat.send("Hi.");
  return s.chat.session!;
}
