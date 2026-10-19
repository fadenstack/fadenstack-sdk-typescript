import type { ToolCallContext, ToolServiceKey, ToolServices } from "@fadenstack/agents";

/** A service for a hand-built call: its key and the service (`[Provenance, new PassThroughProvenance()]`). */
export type ToolServiceEntry = readonly [ToolServiceKey<unknown>, unknown];

/** The services of a hand-built call: these, by key (keys compare by identity, as the SDK's do), and nothing else. */
export function toolServices(...entries: readonly ToolServiceEntry[]): ToolServices {
  const services = new Map<ToolServiceKey<unknown>, unknown>(entries);
  return Object.freeze({ get: <T>(key: ToolServiceKey<T>) => services.get(key as ToolServiceKey<unknown>) as T | undefined });
}

export interface ToolContextOptions {
  /** What the call's `context.services` gives; none by default. `toolServices(...)`, or `provenanceServices()`. */
  services?: ToolServices;
  /** Aborts the call; one that never aborts by default. */
  signal?: AbortSignal;
  callId?: string;
  sessionId?: string;
  turnId?: string;
}

/**
 * A `ToolCallContext` for running a tool's `invoke` (or a `defineTool` `run`) by hand in a test, outside an agent's
 * session: `tool.invoke(args, toolContext())`. No services unless given; a tool that places content through the
 * provenance module gets a pass-through one with `toolContext({ services: provenanceServices() })` from
 * `@fadenstack/testing/provenance`.
 */
export function toolContext(options: ToolContextOptions = {}): ToolCallContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    callId: options.callId ?? "call-1",
    sessionId: options.sessionId ?? "session-1",
    turnId: options.turnId ?? "turn-1",
    services: options.services ?? toolServices(),
  };
}
