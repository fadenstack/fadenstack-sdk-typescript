import { FadenClient, loginWithPassword } from "@fadenstack/client";
import {
  FadenAgent,
  MemorySessionStore,
  defineTool,
  type AgentBuilder,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@fadenstack/agents";
import { FakeGateway, type FakeGatewayOptions } from "@fadenstack/testing";

/** A page document the tools work on. */
export class Pages {
  readonly pages = new Map<number, string>([[7, "Motor M1, 400 V"], [8, "Terminal X2"]]);
  readonly deleted: number[] = [];

  read = defineTool<{ page: number }>({
    name: "read_page",
    description: "Reads a page.",
    toolClass: "read",
    parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    run: ({ page }) => this.pages.get(page) ?? `No page ${page}.`,
  });

  write = defineTool<{ page: number; text: string }>({
    name: "write_page",
    toolClass: "write",
    parameters: { type: "object", properties: { page: { type: "integer" }, text: { type: "string" } }, required: ["page", "text"] },
    run: ({ page, text }) => {
      this.pages.set(page, text);
      return { written: page };
    },
  });

  delete = defineTool<{ page: number }>({
    name: "delete_page",
    toolClass: "destructive",
    parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    run: ({ page }) => {
      this.deleted.push(page);
      return "deleted";
    },
  });
}

export interface Setup {
  gateway: FakeGateway;
  client: FadenClient;
  pages: Pages;
  store: MemorySessionStore;
  asked: ApprovalRequest[];
  agent: FadenAgent;
}

/** A signed-in agent on a fake gateway, with page tools and approvals answered by `answer`. */
export async function setup(
  options: FakeGatewayOptions = {},
  answer: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision> = () => ({ approved: true }),
  configure: (builder: AgentBuilder) => AgentBuilder = (b) => b,
): Promise<Setup> {
  const gateway = new FakeGateway({ agents: [{ slug: "eplan" }], ...options });
  const { client, tokens } = FadenClient.forAgent({ serverUrl: gateway.serverUrl, agent: "eplan", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const pages = new Pages();
  const store = new MemorySessionStore();
  const asked: ApprovalRequest[] = [];
  const builder = FadenAgent.createBuilder()
    .useClient(client)
    .addTools(pages.read, pages.write, pages.delete)
    .useSessionStore(store)
    .useApprovals(async (request) => {
      asked.push(request);
      return answer(request);
    });
  const agent = configure(builder).build();
  return { gateway, client, pages, store, asked, agent };
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export const types = (events: AgentEvent[]) => events.map((e) => e.type);
