import type { FadenTransport } from "../http/transport.js";
import { toWireManifest, type AppManifest } from "../manifest.js";
import { toAgentProfile, toWireEvent, type AgentClientEvent, type AgentProfile } from "../models.js";

/** The server takes at most this many events per report. */
export const MAX_EVENTS_PER_REPORT = 100;

/** The client's agent: its profile, the events the SDK reports, and approvals the gateway waits for. */
export class AgentResource {
  readonly agent: string;
  readonly #transport: FadenTransport;

  constructor(transport: FadenTransport, agent: string) {
    this.#transport = transport;
    this.agent = agent;
  }

  #route(rest: string): URL {
    return this.#transport.gateway(`v1/agents/${encodeURIComponent(this.agent)}/${rest}`);
  }

  /** The agent's current version: model, tool contract, local MCP mode, tool modes; never its instructions. */
  async getProfile(signal?: AbortSignal): Promise<AgentProfile> {
    return toAgentProfile(await this.#transport.get<unknown>(this.#route("profile"), signal));
  }

  /** Reports what the SDK did -- names, counts, outcomes. Up to 100 per call. */
  async report(events: readonly AgentClientEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return;
    if (events.length > MAX_EVENTS_PER_REPORT) {
      throw new RangeError(`At most ${MAX_EVENTS_PER_REPORT} events per report.`);
    }
    await this.#transport.post<unknown>(this.#route("events"), { events: events.map(toWireEvent) }, signal);
  }

  /**
   * Tells the server what the app brings -- its tools with their classes, its context, its greeting -- for its
   * admins to review. The same manifest again is only counted (`isNew` false).
   */
  async reportManifest(manifest: AppManifest, signal?: AbortSignal): Promise<{ sha256: string; isNew: boolean }> {
    const answer = await this.#transport.json<{ sha256?: string; new?: boolean }>(
      "PUT", this.#route("manifest"), toWireManifest(manifest), signal,
    );
    return { sha256: String(answer?.sha256 ?? ""), isNew: Boolean(answer?.new) };
  }

  /** Approves or declines a gateway tool call waiting for the user (`faden.approval_required`). */
  async answerApproval(approvalId: string, approved: boolean, signal?: AbortSignal): Promise<void> {
    await this.#transport.post<unknown>(this.#route(`approvals/${encodeURIComponent(approvalId)}`), { approved }, signal);
  }
}
