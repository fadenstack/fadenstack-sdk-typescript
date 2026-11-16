import {
  EndpointCheck,
  EndpointServer,
  TextWatermarks,
  bytesSha256,
  hostScope,
  type AgentClientEvent,
  type AgentGrant,
  type AgentPrincipal,
  type AgentProfile,
  type AgentToolInfo,
  type AnswerScope,
  type AppManifest,
  type ChatStreamer,
  type EndpointReport,
  type EndpointWatermarkStatus,
  type FadenstackClient,
  type GrantExtension,
  type GrantList,
  type GrantReport,
  type GrantRequest,
  type HostToolCheck,
  type HostToolDecision,
  type ModelEndpoint,
  type SkillList,
  type StepUpPoll,
  type StepUpStarted,
} from "@fadenstack/client";

import type { AgentBackend, AgentConnection } from "./backend.js";
import type { AgentDefinition } from "./definition.js";

/** The standalone principal's tenant and user: its data lives in stores of its own, apart from any governed person's (`userStoreName`). */
export const STANDALONE_ID = "standalone";

/**
 * Where a standalone agent keeps the language its person picked, beyond the run. A browser has no data folder, so the SDK keeps
 * the language in memory for the run only; an app that wants it kept passes a store (`chrome.storage`, `localStorage`) in
 * `LocalProfileOptions.languageStore`. .NET keeps it in a file in the standalone folder.
 */
export interface LocalLanguageStore {
  /** The language kept (a BCP 47 tag), or null for none. A failing read counts as none. */
  read(): Promise<string | null> | string | null;
  /** Keeps the language, or forgets it (null). */
  write(language: string | null): Promise<void> | void;
}

/** What the person set for a standalone agent (sdk/51 F02 §3); the machine policy narrows it (F09). .NET: `LocalProfileOptions`. */
export interface LocalProfileOptions {
  /** Whether the person allows local MCP servers for this agent (off by default). */
  localMcp?: boolean;
  /** Whether local skills are on (on by default: the person's own device, their own skills). */
  localSkills?: boolean;
  /** Whether the model sees pictures, when the person says so; else the endpoint check's word, else unknown. */
  vision?: boolean;
  /** Where the person's language is kept beyond the run; without one it lives in memory (see `LocalLanguageStore`). */
  languageStore?: LocalLanguageStore;
}

/** What `LocalBackend` is made of. */
export interface LocalBackendSettings {
  definition: AgentDefinition;
  /** The model: the endpoint's `DirectChatClient`, or a host's own streamer. */
  chat: ChatStreamer;
  /** The endpoint the agent talks to; undefined for a host's own streamer. */
  endpoint?: ModelEndpoint | undefined;
  report?: EndpointReport | undefined;
  options?: LocalProfileOptions | undefined;
}

const LANGUAGE = /^[\p{L}\p{N}-]{1,35}$/u;

/**
 * The standalone backend (sdk/51 F02 §3, I02 commit 14): no server at all. The profile comes from the app's agent definition
 * (F03) and the endpoint check; there are no events, no grants, no Bypass, no step-up and no server checks; the user's language
 * stays on the device. The data goes under the standalone principal, apart from any governed person's. .NET: `LocalAgentBackend`.
 */
export class LocalBackend implements AgentBackend {
  readonly #settings: LocalBackendSettings;
  readonly #principal: AgentPrincipal;
  #language: string | null | undefined;

  constructor(settings: LocalBackendSettings) {
    this.#settings = settings;
    this.#principal = { tenantId: STANDALONE_ID, userId: STANDALONE_ID, agentId: settings.definition.slug, deviceId: null };
  }

  readonly connection: AgentConnection = "standalone";

  get serverClient(): FadenstackClient | undefined {
    return undefined;
  }

  get chat(): ChatStreamer {
    return this.#settings.chat;
  }

  /** The endpoint's base, when the agent talks to one (not for a host's own streamer). */
  get endpointUrl(): URL | undefined {
    const base = this.#settings.endpoint?.baseUrl;
    return base === undefined ? undefined : base instanceof URL ? base : new URL(String(base));
  }

  /** The kind of server: the check's word, else by the endpoint's host and dialect; unknown for a host's own streamer. */
  get server(): EndpointServer {
    const { endpoint, report } = this.#settings;
    if (report && report.server !== EndpointServer.Unknown) return report.server;
    return endpoint ? EndpointCheck.serverOf(endpoint) : EndpointServer.Unknown;
  }

  /**
   * Whether the connection marks text (F03 item 8): the check's word when the app gave its report, else the sourced table by
   * the endpoint's host and dialect; unknown for a host's own streamer.
   */
  get watermark(): EndpointWatermarkStatus {
    const { endpoint, report } = this.#settings;
    if (report) return report.watermark;
    return endpoint ? EndpointCheck.watermarkOf(endpoint) : TextWatermarks.for(EndpointServer.Unknown, null, false, null);
  }

  readonly acceptsEvents = false;

  async getProfile(): Promise<AgentProfile> {
    const { definition, endpoint, report, options } = this.#settings;
    // Whether the model runs in this network: the desktop's screen pictures read it. A host's own streamer: unknown, so
    // external (fail closed). A browser cannot resolve a name, so only the host's own spelling decides (`hostScope`).
    const url = this.endpointUrl;
    const residency = url === undefined || hostScope(url.hostname) === "public" ? "external" : "private";
    const ui: Record<string, unknown> = { ...(definition.ui ?? {}), model_residency: residency };
    return {
      principal: { ...this.#principal },
      id: definition.slug,
      slug: definition.slug,
      name: definition.name,
      version: null,
      draft: false,
      model: endpoint?.model ? endpoint.model : report?.model || null,
      vision: options?.vision ?? report?.vision ?? null,
      images: false, // pictures in standalone wait for D17 (owner, 14 Nov)
      skills: false, // no server list; local skills come with F04
      instructionsSha256: await bytesSha256(new TextEncoder().encode(definition.instructions)),
      hostToolContract: definition.hostToolContract.map((entry) => ({ ...entry })),
      serverTools: null,
      knowledge: [],
      // Standalone: the person decides per server; this computer's policy can still forbid it (the agent narrows the profile).
      localMcp: { mode: options?.localMcp ? "allow" : "disable", developerMode: false, plainHttp: "allow" },
      localSkills: { mode: options?.localSkills === false ? "disable" : "allow", developerMode: false },
      // Ask to start, Auto at most: no local Bypass (D4 later).
      toolModes: { default: "ask", ceiling: "auto", max: "auto", openWorldEnforced: false },
      // No `approvals` block: no grants, so no Bypass and no grant card.
      ui,
      extensions: {},
      requiredClientModules: [],
      edition: STANDALONE_ID,
      features: [], // no grants, no Bypass, no dispatch check
      user: { language: await this.#readLanguage() },
    };
  }

  // ---- the user's language: in memory, and in the host's store when it gave one ----

  async #readLanguage(): Promise<string | null> {
    if (this.#language !== undefined) return this.#language;
    let kept: string | null = null;
    try {
      const value = await this.#settings.options?.languageStore?.read();
      kept = typeof value === "string" && LANGUAGE.test(value.trim()) ? value.trim() : null;
    } catch {
      kept = null; // an unreadable store is no language, as an unreadable file is in .NET
    }
    return (this.#language = kept);
  }

  async setUserLanguage(language: string | null): Promise<string | null> {
    const tag = language?.trim() ?? "";
    if (tag.length > 0 && !LANGUAGE.test(tag)) throw new TypeError("A language is a BCP 47 tag, such as de or zh-Hans.");
    const kept = tag.length > 0 ? tag : null;
    await this.#settings.options?.languageStore?.write(kept);
    return (this.#language = kept);
  }

  // ---- what a server does and standalone has not ----

  report(_events: readonly AgentClientEvent[]): Promise<void> {
    return Promise.resolve();
  }

  reportManifest(_manifest: AppManifest): Promise<{ sha256: string; isNew: boolean }> {
    return Promise.resolve({ sha256: "", isNew: false });
  }

  listSkills(): Promise<SkillList> {
    return Promise.resolve({ available: false, skills: [] });
  }

  listTools(): Promise<AgentToolInfo[] | null> {
    return Promise.resolve([]);
  }

  answerApproval(_approvalId: string, _approved: boolean, _scope: AnswerScope, _argumentsSha256?: string): Promise<void> {
    return Promise.reject(noServer("a gateway approval"));
  }

  /** Never a blanket allow: without a server there is no central word, and the local class and floor decide. */
  checkHostTool(_check: HostToolCheck): Promise<HostToolDecision> {
    return Promise.resolve({
      decision: "deny",
      toolClass: "unknown",
      effectiveToolMode: "off",
      requiredByRule: false,
      message: "There is no server to check host tools with.",
      profileStamp: "",
      argumentsStamp: "",
      decisionStamp: "",
      principal: { ...this.#principal },
    });
  }

  createGrant(_request: GrantRequest): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  reportGrant(_id: string, _calls: readonly string[]): Promise<GrantReport> {
    return Promise.reject(noServer("grants"));
  }

  getGrant(_id: string): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  extendGrant(_id: string, _extension: GrantExtension): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  revokeGrant(_id: string): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  pauseGrant(_id: string): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  resumeGrant(_id: string): Promise<AgentGrant> {
    return Promise.reject(noServer("grants"));
  }

  listGrants(): Promise<GrantList> {
    return Promise.reject(noServer("grants"));
  }

  startStepUp(): Promise<StepUpStarted> {
    return Promise.reject(noServer("a second sign-in"));
  }

  pollStepUp(): Promise<StepUpPoll> {
    return Promise.reject(noServer("a second sign-in"));
  }
}

const noServer = (what: string): Error =>
  new Error(`This agent runs on the person's own endpoint, without a Fadenstack server: it has no ${what}.`);
