import { FadenstackError } from "@fadenstack/client";

import type { FadenstackAgent } from "./agent.js";

/**
 * The second sign-in before Bypass is switched on (sdk/41; OWASP ASVS 5.0 7.5.3): the person signs in again in the
 * browser -- the account's password, or the organisation's sign-in forced fresh -- and approves there, as when the app was
 * paired. The app never sees a password. Only the Bypass card's Allow (or an app set to `bypass` permission mode)
 * starts one; never the model. .NET: `Fadenstack.Agents.StepUpRequest`.
 */
export interface StepUpRequest {
  /** The conversation whose Bypass it is for; undefined for one started before its conversation exists. */
  readonly conversationId?: string;
  /** The page to open, with its code in the fragment (no server sees it). Always on the API's own origin. */
  readonly link: URL;
  /** The code the page shows (`XXXX-XXXX`), for the person to compare. */
  readonly userCode: string;
  /** When the step-up stops working, by this device's clock. */
  readonly expiresAt: Date;
}

/**
 * How a second sign-in stands: `browser` (the page is open; the app waits), `approved` (the app has the proof and asks
 * the server for the grant), `denied`, `timed_out` (nobody approved it in time), `failed` (the page could not be opened,
 * or the server could not be reached), `cancelled` (the app stopped waiting).
 */
export type StepUpStage = "browser" | "approved" | "denied" | "timed_out" | "failed" | "cancelled";

/**
 * The app's side of the second sign-in: it opens the link in a window of its own -- the system browser or a new tab,
 * never an iframe of the app's page -- and shows that it waits. A UI's approval handler that also implements this is
 * used for it; an app without one gets no Bypass (and announces none).
 */
export interface StepUpHandler {
  /** Opens the request's link in the person's browser; false when it could not (then no Bypass). */
  open(request: StepUpRequest, signal: AbortSignal): Promise<boolean>;
  /** How the second sign-in stands now, for the app to show. */
  report(request: StepUpRequest, stage: StepUpStage): void;
}

/** Whether `value` has the shape of a step-up handler (an approval handler may be one too). */
export function isStepUpHandler(value: unknown): value is StepUpHandler {
  return value !== null && typeof value === "object"
    && typeof (value as { open?: unknown }).open === "function" && typeof (value as { report?: unknown }).report === "function";
}

/** A Bypass that was not switched on because the second sign-in did not happen (`stage` says why). */
export class BypassSignInError extends Error {
  readonly stage: StepUpStage;
  constructor(stage: StepUpStage, message: string) {
    super(message);
    this.name = "BypassSignInError";
    this.stage = stage;
  }
}

/**
 * Opens `link` (http or https only) in a new browser window or tab, never an iframe, and cuts the new page off from this
 * one (no `opener`). False when the browser blocked it or there is no window (a worker, a server). For a browser app; an
 * extension or a desktop shell gives its own handler.
 */
export function openInBrowser(link: URL | string): boolean {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const open = (globalThis as { open?: (url: string, target?: string) => { opener: unknown } | null }).open;
    if (typeof open !== "function") return false;
    const opened = open.call(globalThis, url.href, "_blank");
    if (!opened) return false;
    opened.opener = null;
    return true;
  } catch {
    return false;
  }
}

/** A step-up handler that opens the page with `openInBrowser`; `report` shows the stages, if the app wants them. */
export function browserStepUp(report: (request: StepUpRequest, stage: StepUpStage) => void = () => undefined): StepUpHandler {
  return { open: (request) => Promise.resolve(openInBrowser(request.link)), report };
}

/** A proof this close to its end is not used: the request could arrive after it. */
const MARGIN_MS = 15_000;

/** Waits `ms`, or ends with the signal's reason. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The device's proof of a fresh sign-in for Bypass (sdk/41), in memory only: never logged, never written to a store,
 * never in a transcript. One proof covers every Bypass the person switches on with this agent on this device while it is
 * fresh (5 minutes by the server's clock): parallel chats need one sign-in. .NET: `StepUpProofs`.
 * @internal
 */
export class StepUpProofs {
  readonly #agent: FadenstackAgent;
  #proof: string | undefined;
  #until = 0;
  #queue: Promise<unknown> = Promise.resolve();

  /** Waits between polls; a test makes it instant. */
  delay: (ms: number, signal: AbortSignal) => Promise<void> = wait;

  constructor(agent: FadenstackAgent) {
    this.#agent = agent;
  }

  /** The proof while it is fresh; undefined otherwise. */
  get fresh(): string | undefined {
    return this.#proof !== undefined && this.#agent.clock() < this.#until ? this.#proof : undefined;
  }

  /** Forgets the proof (the server refused it). */
  forget(): void {
    this.#proof = undefined;
    this.#until = 0;
  }

  /**
   * A fresh proof: the one held while it lasts, else a new second sign-in through `handler`. Parallel chats asking at
   * once share one sign-in. Throws `BypassSignInError` when none came of it.
   */
  obtain(handler: StepUpHandler, conversationId: string | undefined, longestMinutes: number | undefined, signal: AbortSignal): Promise<string> {
    const run = this.#queue.then(() => this.fresh ?? this.#signInAgain(handler, conversationId, longestMinutes, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #signInAgain(handler: StepUpHandler, conversationId: string | undefined, longestMinutes: number | undefined,
    signal: AbortSignal): Promise<string> {
    const api = this.#agent.client.agent!;
    let started;
    try {
      started = await api.startStepUp(longestMinutes, this.#agent.grants.clientVersion, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof FadenstackError) throw new BypassSignInError("failed", `The second sign-in could not be started: ${error.message}`);
      throw error;
    }
    const request: StepUpRequest = {
      ...(conversationId !== undefined ? { conversationId } : {}),
      link: new URL(started.verificationUriComplete),
      userCode: started.userCode,
      expiresAt: new Date(this.#agent.clock() + started.expiresIn * 1000),
    };
    let opened: boolean;
    try {
      opened = await handler.open(request, signal);
    } catch (error) {
      if (signal.aborted) {
        handler.report(request, "cancelled");
        throw signal.reason ?? error;
      }
      opened = false;
    }
    if (!opened) {
      handler.report(request, "failed");
      throw new BypassSignInError("failed", "The browser could not be opened for the second sign-in.");
    }
    handler.report(request, "browser");
    let interval = Math.max(1, started.interval);
    try {
      while (this.#agent.clock() < request.expiresAt.getTime()) {
        await this.delay(interval * 1000, signal);
        const { proof, error, interval: slower } = await api.pollStepUp(started.stepUpCode, signal);
        if (proof && proof.proof.length > 0) {
          this.#proof = proof.proof;
          this.#until = this.#agent.clock() + proof.expiresIn * 1000 - MARGIN_MS;
          handler.report(request, "approved");
          return proof.proof;
        }
        switch (error) {
          case "authorization_pending":
            continue;
          case "slow_down":
            interval = Math.max(interval + 5, slower ?? 0);
            continue;
          case "expired_token":
            handler.report(request, "timed_out");
            throw new BypassSignInError("timed_out", "The second sign-in took too long.");
          default:
            handler.report(request, "denied");
            throw new BypassSignInError("denied", "The second sign-in was denied.");
        }
      }
    } catch (error) {
      if (error instanceof BypassSignInError) throw error;
      if (signal.aborted) {
        handler.report(request, "cancelled");
        throw signal.reason ?? error;
      }
      if (error instanceof FadenstackError) {
        handler.report(request, "failed");
        throw new BypassSignInError("failed", `The second sign-in could not be checked: ${error.message}`);
      }
      throw error;
    }
    handler.report(request, "timed_out");
    throw new BypassSignInError("timed_out", "The second sign-in took too long.");
  }
}
