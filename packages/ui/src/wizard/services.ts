import type { MachinePolicy } from "@fadenstack/agents";
import {
  AgentPairing,
  AgentTokenProvider,
  EndpointCheck,
  FadenstackPairingAgentError,
  FadenstackPermissionError,
  checkServer,
  loginWithPassword,
  type AgentPairingOptions,
  type EndpointCheckOptions,
  type FadenstackLogger,
  type FetchLike,
  type PairingClient,
  type PairingStart,
  type SignedInUser,
  type TokenStore,
} from "@fadenstack/client";

import {
  AgentAccess,
  createPairingTicket,
  type AgentSignIn,
  type EndpointChecker,
  type PairingApproval,
  type PairingTicket,
  type ServerSignIn,
  type WizardClock,
} from "./contracts.js";

// The wizard's default services (sdk/51 F15; I15 §2, §3). .NET: WizardServices.cs (`ServerSignIn`, `EndpointChecker`,
// `SystemWizardClock`).

/** What `createServerSignIn` needs. */
export interface ServerSignInOptions {
  /** The token store the app's `AgentTokenProvider`s use. */
  tokenStore: TokenStore;
  /** The app's agents, the main one first (at most `MAX_PAIRING_AGENTS`). */
  agents: readonly string[];
  /** Names the sign-in in the person's list, e.g. "Word assistant on SACHI-PC". */
  deviceLabel: string;
  /** What the app says about itself on the approval page. */
  client: PairingClient;
  /** The machine policy: plain http goes only to its own http server (this machine, which the SDK allows anyway). */
  policy?: MachinePolicy | undefined;
  /** The `fetch` requests go through (tests, a host's proxy); the global one by default. */
  fetch?: FetchLike | undefined;
  logger?: FadenstackLogger | undefined;
  /** The time and how to wait between polls, for tests (`AgentPairingOptions.now`, `delay`); the clock and a timer by default. */
  timing?: Pick<AgentPairingOptions, "now" | "delay"> | undefined;
}

/** The pairing and its start, kept in a ticket's `handle`: what the client polls with stays inside the SDK's start object. */
class ServerPairing {
  readonly pairing: AgentPairing;
  readonly start: PairingStart;
  constructor(pairing: AgentPairing, start: PairingStart) {
    this.pairing = pairing;
    this.start = start;
  }

  toString(): string {
    return "ServerPairing";
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const place = (url: URL): string => `${url.origin}${url.pathname}`.replace(/\/+$/, "").toLowerCase();

/**
 * The server side of the wizard over the SDK (`ServerSignIn`): `checkServer`, one `AgentPairing` for all of the app's agents
 * (sdk/47: one approval), and the password sign-in (`loginWithPassword`, then `AgentTokenProvider.signIn` per agent). Tokens
 * go to the token store; the pairing code stays inside the SDK's start object; the password is passed once and kept
 * nowhere. Plain http goes only to the server the machine policy names (ASVS 5.0 V12). .NET: `ServerSignIn`.
 */
export function createServerSignIn(options: ServerSignInOptions): ServerSignIn {
  if (!options?.tokenStore) throw new TypeError("A token store is needed.");
  if (!options.agents?.length) throw new TypeError("Name the app's agents, the main one first.");
  if (!options.client) throw new TypeError("Say what the app is (client).");
  const { tokenStore: store, deviceLabel = "", client, policy, logger } = options;
  const agents = [...options.agents];
  const fetch = options.fetch;
  const allowsHttp = (server: URL): boolean =>
    policy?.server !== undefined && policy.server.protocol === "http:" && place(policy.server) === place(server);
  const pairingFor = (server: URL): AgentPairing =>
    new AgentPairing({ apiUrl: server, store, allowInsecureHttp: allowsHttp(server), ...(fetch ? { fetch } : {}), ...(logger ? { logger } : {}), ...options.timing });
  const handleOf = (ticket: PairingTicket): ServerPairing => {
    if (ticket?.handle instanceof ServerPairing) return ticket.handle;
    throw new TypeError("The ticket is not this sign-in's.");
  };
  const ticketOf = (pairing: AgentPairing, start: PairingStart): PairingTicket =>
    createPairingTicket({
      userCode: start.userCode, verificationUri: start.verificationUri, verificationUriComplete: start.verificationUriComplete,
      expiresAt: start.expiresAt, agents, handle: new ServerPairing(pairing, start),
    });

  return {
    check: (server, signal) =>
      checkServer({ server, signal, allowInsecureHttp: allowsHttp(server), ...(fetch ? { fetch } : {}) }),

    async start(server, signal) {
      const pairing = pairingFor(server);
      return ticketOf(pairing, await pairing.start(agents[0]!, deviceLabel, client, { agents: agents.slice(1), signal }));
    },

    async wait(ticket, onRetrying, signal) {
      const { pairing, start } = handleOf(ticket);
      try {
        const result = await pairing.wait(start, { signal, onProgress: (progress) => onRetrying(progress.state === "retrying") });
        return { person: result.signedInUser, agents: [{ agent: result.agentSlug, access: AgentAccess.Approved }] };
      } catch (error) {
        if (!(error instanceof FadenstackPairingAgentError)) throw error;
        // The person approved others but not the main agent; the first approved other one was collected to tell this from
        // an unknown code. The ones still to collect are left out: the wizard redeems them.
        const left = start.agentsLeft;
        const main = ticket.agents[0]!;
        const signed: AgentSignIn[] = ticket.agents
          .map((agent): AgentSignIn => ({
            agent,
            access: sameText(agent, main) ? AgentAccess.Refused : left.some((l) => sameText(l, agent)) ? AgentAccess.Left : AgentAccess.Approved,
          }))
          .filter((a) => a.access !== AgentAccess.Left);
        return { person: undefined, agents: signed };
      }
    },

    async redeem(ticket, agent, signal) {
      const { pairing, start } = handleOf(ticket);
      if (start.agents.length === 0) return { agent, access: AgentAccess.Left }; // an older server: one agent per pairing
      try {
        await pairing.redeem(start, agent, signal);
        return { agent, access: AgentAccess.Approved };
      } catch (error) {
        if (error instanceof FadenstackPairingAgentError) return { agent, access: AgentAccess.Refused };
        throw error;
      }
    },

    async signInWithPassword(server, email, password, signal): Promise<PairingApproval> {
      const allow = allowsHttp(server);
      const loginToken = await loginWithPassword({ apiUrl: server, email, password, signal, allowInsecureHttp: allow, ...(fetch ? { fetch } : {}) });
      let person: SignedInUser | undefined;
      const signed: AgentSignIn[] = [];
      for (const agent of agents) {
        const provider = new AgentTokenProvider({ apiUrl: server, agent, store, allowInsecureHttp: allow, ...(fetch ? { fetch } : {}) });
        try {
          const tokens = await provider.signIn(loginToken, deviceLabel, signal);
          person ??= tokens.user;
          signed.push({ agent, access: AgentAccess.Approved });
        } catch (error) {
          if (!(error instanceof FadenstackPermissionError)) throw error;
          signed.push({ agent, access: AgentAccess.Refused });
        }
      }
      return { person, agents: signed };
    },

    // TS only (I15 §2): a pairing that survives a closed side panel. The export holds the pairing code.
    export(ticket) {
      const { pairing, start } = handleOf(ticket);
      return pairing.export(start);
    },

    resume(server, saved) {
      const pairing = pairingFor(server);
      return ticketOf(pairing, pairing.resume(saved));
    },
  };
}

/**
 * The endpoint side of the wizard over `EndpointCheck`. **`placeOf` answers at once** (a browser cannot resolve names: the
 * host's own spelling decides) and **`findLocal` finds nothing** (a browser may not scan ports; F03). .NET: `EndpointChecker`.
 */
export function createEndpointChecker(options?: EndpointCheckOptions): EndpointChecker {
  return {
    findLocal: () => Promise.resolve([]),
    placeOf: (baseUrl) => EndpointCheck.placeOf(baseUrl),
    check: (endpoint, signal) => new EndpointCheck(endpoint).run({ ...options, signal }),
  };
}

/** The wizard's clock on this device: `Date.now` and `setTimeout`. .NET: `SystemWizardClock` (which posts to the UI thread; JS has none). */
export function createSystemClock(): WizardClock {
  return {
    now: () => Date.now(),
    after(delayMs, action) {
      const timer = setTimeout(action, Math.max(0, delayMs));
      return () => clearTimeout(timer);
    },
  };
}
