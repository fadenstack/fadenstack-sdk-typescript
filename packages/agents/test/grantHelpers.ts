import {
  ApprovalDecision,
  EntryTypes,
  GrantAnswer,
  type AgentBuilder,
  type ChatSession,
  type ApprovalHandler,
  type ApprovalRequest,
  type GrantHandler,
  type GrantOffer,
  type StepUpHandler,
  type StepUpRequest,
  type StepUpStage,
} from "@fadenstack/agents";
import type { FakeGrantsOptions, FakeModel, FakeReply } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup, type Setup } from "./helpers.js";

/** What a 0.7 server offers an agent that announced Bypass: up to an hour, the second sign-in, calls as evidence. */
export const OFFERED: Record<string, unknown> = {
  standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"],
  bypass: { allowed: true, longest_minutes: 60, evidence: "calls", step_up: { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" } },
};

/** The same without Bypass: a server of 0.7.0 before the flow. */
export const WITHOUT_BYPASS: Record<string, unknown> = { standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"] };

/** An approval handler that is also the grant card and the step-up handler, as a UI's broker is (.NET: `BypassTests.Card`). */
export class Card implements ApprovalHandler, GrantHandler, StepUpHandler {
  readonly offers: GrantOffer[] = [];
  /** The links of second sign-ins it opened (never in a real browser), and what it was told. */
  readonly opened: StepUpRequest[] = [];
  readonly stages: StepUpStage[] = [];
  readonly asked: ApprovalRequest[] = [];
  /** Whether it can open the browser. */
  canOpen = true;
  /** The person's own words on the Bypass card, if any. */
  reason: string | undefined;

  /** @param allow The answer to an offer (the Bypass confirmation). @param approve The answer to a question about one call. */
  constructor(readonly allow = true, readonly approve = false, readonly place?: (offer: GrantOffer) => GrantAnswer) {}

  open(request: StepUpRequest): Promise<boolean> {
    this.opened.push(request);
    return Promise.resolve(this.canOpen);
  }

  report(_request: StepUpRequest, stage: StepUpStage): void {
    this.stages.push(stage);
  }

  request(request: ApprovalRequest): Promise<ReturnType<typeof ApprovalDecision.approve>> {
    this.asked.push(request);
    return Promise.resolve(this.approve ? ApprovalDecision.approve() : ApprovalDecision.deny());
  }

  requestGrant(offer: GrantOffer): Promise<GrantAnswer> {
    this.offers.push(offer);
    if (this.place) return Promise.resolve(this.place(offer));
    return Promise.resolve(this.allow
      ? { allowed: true, places: [], duration: offer.preselected, shownText: "Bypass for 30 minutes.", ...(this.reason ? { reason: this.reason } : {}) }
      : GrantAnswer.notNow);
  }
}

/** The model's replies in order, as the .NET tests script their gateway; when they are used up it says "Done.". */
export class Script {
  readonly #queue: FakeReply[] = [];
  readonly model: FakeModel = () => this.#queue.shift() ?? { text: "Done." };

  says(text: string): this {
    this.#queue.push({ text });
    return this;
  }

  calls(...calls: { id: string; name: string; arguments: Record<string, unknown> }[]): this {
    this.#queue.push({ toolCalls: calls });
    return this;
  }

  /** One reply with raw gateway events, and the calls the model makes in it. */
  reply(reply: FakeReply): this {
    this.#queue.push(reply);
    return this;
  }

  /** The gateway says a grant covers the call, then the model calls the tool. */
  covered(id: string, name: string, args: Record<string, unknown>, grantId: string): this {
    return this.reply({ events: [grantUsed(id, name, grantId)], toolCalls: [{ id, name, arguments: args }] });
  }
}

export const grantUsed = (callId: string, toolCallName: string, grantId: string) =>
  ({ type: "CUSTOM", name: "faden.grant_used", value: { toolCallId: callId, toolCallName, grantId } });

/** The gateway marks a call of the agent's own tool as an admin's "Ask first" rule. */
export const ruleMark = (callId: string, toolCallName: string, message = "Needs approval.") =>
  ({ type: "CUSTOM", name: "faden.approval_required", value: { toolCallId: callId, toolCallName, message, rule: true } });

export interface Fixture extends Setup {
  script: Script;
  card: Card;
  grants: NonNullable<Setup["gateway"]["grants"]>;
}

/** An agent on a fake server that holds grants and offers Bypass; the second sign-in polls without waiting. */
export async function fixture(options: {
  approvals?: Record<string, unknown>;
  maxLevel?: string;
  card?: Card;
  grants?: FakeGrantsOptions;
  contract?: { name: string; risk?: "read" | "write" | "destructive"; approval?: string; target_type?: string; target_argument?: string }[];
  configure?: (builder: AgentBuilder) => AgentBuilder;
  principal?: boolean;
} = {}): Promise<Fixture> {
  const script = new Script();
  const card = options.card ?? new Card();
  const s = await setup(
    { model: script.model, grants: { approvals: options.approvals ?? OFFERED, ...options.grants },
      agents: [{ slug: "docs", contract: options.contract ?? [...PAGE_CONTRACT], maxLevel: options.maxLevel ?? "bypass" }] },
    undefined,
    (b) => (options.configure ?? ((x) => x))(b.useApprovals(card)),
  );
  s.agent.stepUps.delay = () => Promise.resolve();
  return { ...s, script, card, grants: s.gateway.grants! };
}

export const decisions = (session: ChatSession) =>
  session.transcript.filter((e) => e.type === EntryTypes.approvalDecision).map((e) => e.data);

/** The requests the fake got that made grants (the refused ones too). */
export const grantPosts = (s: Setup) => s.gateway.requests.filter((r) => r.method === "POST" && r.path.endsWith("/grants"));
