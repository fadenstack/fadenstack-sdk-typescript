import { writeLog, type FadenstackLogger, type ToolClass } from "@fadenstack/client";

import { AgentLog } from "./log.js";

/** How a hooked call ended. */
export type HookOutcome = "ok" | "error" | "denied" | "cancelled";

/** What the agent's policy decided about a tool call, before a hook is asked: the hook can only make it stricter. */
export type ToolPolicyDecision = "runs" | "asks" | "refused";

/** The most characters of a deny or ask reason. */
export const MAX_HOOK_REASON = 500;
/** The most notes a call keeps (all hooks together). */
export const MAX_HOOK_NOTES = 8;
/** The most characters of a note's key. */
export const MAX_HOOK_NOTE_KEY = 64;
/** The most characters of a note's value. */
export const MAX_HOOK_NOTE_VALUE = 200;

/** What a hook sees before a model call. No prompt text unless the app asked for it (`AgentBuilder.useHookContent`). */
export interface ModelCallHookContext {
  readonly agentName: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Which model call of the turn this is, from 1. */
  readonly round: number;
  /** The model's name as the agent's profile gives it; undefined when it does not say. */
  readonly model: string | undefined;
  readonly messageCount: number;
  readonly toolCount: number;
  /** The messages; only when the app asked for content, otherwise undefined. */
  readonly messages: readonly unknown[] | undefined;
}

/** What a hook sees after a model call. No answer text unless the app asked for it. */
export interface ModelCallHookResult {
  readonly agentName: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly round: number;
  readonly model: string | undefined;
  readonly outcome: HookOutcome;
  readonly durationMs: number;
  /** Tokens sent and received, when the model said; otherwise undefined. */
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  /** How many tool calls the model asked for. */
  readonly toolCallCount: number;
  /** The answer text; only when the app asked for content, otherwise undefined. */
  readonly text: string | undefined;
}

/**
 * What a hook sees before a tool call, after the policy decided. Everything is read-only and frozen: a hook cannot change the
 * tool, its class or the policy's decision (OWASP ASVS 5.0 V8).
 */
export interface ToolCallHookContext {
  readonly agentName: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  /** Where the tool comes from: `host` (the app's own), `mcp`, `gateway`, `skills` and so on. */
  readonly source: string;
  /** The server the tool belongs to (a local MCP server's name), or undefined. */
  readonly server: string | undefined;
  /** The tool's class as the policy sees it (the stricter of the tool's own and the gateway's): a copy, it cannot be set. */
  readonly toolClass: ToolClass;
  readonly callId: string;
  /** The arguments the model gave (a frozen copy). */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** What the policy decided: runs, asks, or refused. */
  readonly decision: ToolPolicyDecision;
}

/** What a hook sees after a tool call. */
export interface ToolCallHookResult {
  readonly agentName: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly source: string;
  readonly server: string | undefined;
  readonly toolClass: ToolClass;
  readonly callId: string;
  /** What the policy decided before the call. */
  readonly decision: ToolPolicyDecision;
  readonly outcome: HookOutcome;
  /** How long the tool ran, not counting the time the user took to answer an approval card. */
  readonly durationMs: number;
  /** The result text, only for the app's own (`host`) tools; undefined for every other source. */
  readonly resultText: string | undefined;
}

/**
 * A hook's answer before a tool call: go on, ask, or deny. There is no answer that approves (OWASP ASVS 5.0 V8: a hook may make a
 * call stricter, never looser), and any other value a hook returns counts as "go on". `notes` are short key/value notes kept in
 * the transcript's entry of this call and never sent to the server (at most 8 notes of 64 and 200 characters).
 */
export type ToolHookVerdict =
  | { readonly action: "continue"; readonly notes?: Readonly<Record<string, string>> }
  | { readonly action: "ask"; readonly reason?: string; readonly notes?: Readonly<Record<string, string>> }
  | { readonly action: "deny"; readonly reason: string; readonly notes?: Readonly<Record<string, string>> };

/** The ways to answer before a tool call. */
export const toolHook = Object.freeze({
  /** Go on as the policy decided. */
  continue: (notes?: Record<string, string>): ToolHookVerdict => Object.freeze({ action: "continue", ...(notes ? { notes } : {}) }),
  /**
   * Ask the user first: a call the policy would run unasked shows the approval card (once only: no earlier "allow" and no grant
   * answers it). A call the policy already asks about is asked as before.
   */
  ask: (reason?: string, notes?: Record<string, string>): ToolHookVerdict =>
    Object.freeze({ action: "ask", ...(reason !== undefined ? { reason } : {}), ...(notes ? { notes } : {}) }),
  /** Refuse the call; `reason` (cut to 500 characters) reaches the model as a declined call. */
  deny: (reason: string, notes?: Record<string, string>): ToolHookVerdict => Object.freeze({ action: "deny", reason, ...(notes ? { notes } : {}) }),
});

/**
 * The hook API of the agent (sdk/51 F07): the app's code watching each model call and tool call, and able to make a tool call
 * stricter. Every method is optional. Add hooks with `AgentBuilder.addHooks`. .NET: `IAgentHooks`.
 *
 * The rule that keeps the floor (OWASP ASVS 5.0 V8): `beforeToolCall` runs after the policy decided, and its answer can only go on,
 * ask or deny. Order: before-hooks in ascending `order`, then in the order added; after-hooks in the reverse order. A hook that
 * throws never breaks the run: it is logged (event 2060: its name and the error's type, never its message) and counts as "go on".
 */
export interface AgentHooks {
  /** A name for the log when a hook throws; the constructor's name when absent. */
  readonly name?: string;
  beforeModelCall?(context: ModelCallHookContext, signal: AbortSignal): void | Promise<void>;
  afterModelCall?(result: ModelCallHookResult, signal: AbortSignal): void | Promise<void>;
  beforeToolCall?(context: ToolCallHookContext, signal: AbortSignal): ToolHookVerdict | void | Promise<ToolHookVerdict | void>;
  afterToolCall?(result: ToolCallHookResult, signal: AbortSignal): void | Promise<void>;
}

/** What the before-tool hooks said together: the strictest answer, and the notes. */
export interface ToolHookAnswer {
  readonly ask: boolean;
  readonly deny: boolean;
  readonly reason: string | undefined;
  readonly notes: readonly (readonly [string, string])[];
}

export const GO_ON: ToolHookAnswer = Object.freeze({ ask: false, deny: false, reason: undefined, notes: Object.freeze([]) });

/** Cuts text to `max` characters, never in the middle of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/** A frozen copy of the arguments, so a hook can neither change what the tool gets nor what is shown on the card. */
export function frozenCopy(args: Record<string, unknown>): Readonly<Record<string, unknown>> {
  try {
    return deepFreeze(structuredClone(args));
  } catch {
    return deepFreeze({ ...args });
  }
}

/**
 * Runs the agent's hooks in order and keeps them from breaking the run. The one place that turns a hook's answer into a
 * `ToolHookAnswer`, and it can only produce "go on", "ask" or "deny" (ASVS 5.0 V8): the caller never reads an answer as an approval.
 */
export class HookRunner {
  readonly #hooks: readonly AgentHooks[];
  readonly #logger: FadenstackLogger | undefined;
  /** The app asked for message and answer text in the model-call hooks. */
  readonly content: boolean;

  constructor(hooks: readonly AgentHooks[], content: boolean, logger: FadenstackLogger | undefined) {
    this.#hooks = hooks;
    this.content = content;
    this.#logger = logger;
  }

  get any(): boolean {
    return this.#hooks.length > 0;
  }

  async beforeModel(context: ModelCallHookContext, signal: AbortSignal): Promise<void> {
    for (const hook of this.#hooks) {
      if (!hook.beforeModelCall) continue;
      try {
        await hook.beforeModelCall(context, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        this.#failed(hook, error);
      }
    }
  }

  async afterModel(result: ModelCallHookResult, signal: AbortSignal): Promise<void> {
    for (let i = this.#hooks.length - 1; i >= 0; i--) {
      const hook = this.#hooks[i]!;
      if (!hook.afterModelCall) continue;
      try {
        await hook.afterModelCall(result, signal);
      } catch (error) {
        if (!signal.aborted) this.#failed(hook, error);
      }
    }
  }

  /**
   * Asks each hook in order. A deny stops the line: later hooks are not asked. A throwing hook counts as "go on". When `mayChange`
   * is false (the policy already refused the call) the hooks are told and their answers are dropped.
   */
  async beforeTool(context: ToolCallHookContext, mayChange: boolean, signal: AbortSignal): Promise<ToolHookAnswer> {
    let ask = false;
    let askReason: string | undefined;
    const notes: [string, string][] = [];
    for (const hook of this.#hooks) {
      if (!hook.beforeToolCall) continue;
      let verdict: ToolHookVerdict | void = undefined;
      try {
        verdict = await hook.beforeToolCall(context, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        this.#failed(hook, error);
      }
      if (!verdict || typeof verdict !== "object") continue; // nothing said: go on
      const said = verdict as { action?: unknown; reason?: unknown; notes?: unknown };
      if (said.notes && typeof said.notes === "object") {
        for (const [key, value] of Object.entries(said.notes as Record<string, unknown>)) {
          if (notes.length >= MAX_HOOK_NOTES) break;
          if (!key.trim()) continue;
          notes.push([cut(key.trim(), MAX_HOOK_NOTE_KEY), cut(typeof value === "string" ? value : String(value ?? ""), MAX_HOOK_NOTE_VALUE)]);
        }
      }
      if (!mayChange) continue;
      const reason = typeof said.reason === "string" ? cut(said.reason, MAX_HOOK_REASON) : undefined;
      // Only these two words change anything; every other value, "approve" included, is "go on".
      if (said.action === "deny") return { ask: false, deny: true, reason: reason?.trim() ? reason : "declined by the app", notes };
      if (said.action === "ask" && !ask) [ask, askReason] = [true, reason];
    }
    return { ask, deny: false, reason: askReason, notes };
  }

  async afterTool(result: ToolCallHookResult, signal: AbortSignal): Promise<void> {
    for (let i = this.#hooks.length - 1; i >= 0; i--) {
      const hook = this.#hooks[i]!;
      if (!hook.afterToolCall) continue;
      try {
        await hook.afterToolCall(result, signal);
      } catch (error) {
        if (!signal.aborted) this.#failed(hook, error);
      }
    }
  }

  /** The hook's name and the error's type: never the message, which may hold content (ASVS 5.0 V16). */
  #failed(hook: AgentHooks, error: unknown): void {
    writeLog(this.#logger, AgentLog.hookFailed, {
      HookType: hook.name ?? hook.constructor?.name ?? "(hook)",
      ErrorType: error instanceof Error ? error.constructor?.name || error.name : typeof error,
    });
  }
}
