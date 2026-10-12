import { sessionInfo, type SessionInfo, type TranscriptEntry } from "./transcript.js";

/**
 * Where an agent's sessions live: on the device. Integrators may plug their own (e.g. into the host
 * application's project).
 */
export interface SessionStore {
  append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void>;
  read(agent: string, sessionId: string): Promise<TranscriptEntry[]>;
  /** Newest first. */
  list(agent: string): Promise<SessionInfo[]>;
  delete(agent: string, sessionId: string): Promise<void>;
}

/** How many sessions, and how old, are kept per agent (defaults: 50, 90 days). */
export interface SessionRetention {
  maxSessions: number;
  maxAgeDays: number;
}

export const DEFAULT_RETENTION: SessionRetention = { maxSessions: 50, maxAgeDays: 90 };

/** Sessions in memory only: gone with the page or process. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, TranscriptEntry[]>();

  append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
    const key = `${agent}/${sessionId}`;
    const entries = this.#sessions.get(key) ?? [];
    entries.push(structuredClone(entry));
    this.#sessions.set(key, entries);
    return Promise.resolve();
  }

  read(agent: string, sessionId: string): Promise<TranscriptEntry[]> {
    return Promise.resolve(structuredClone(this.#sessions.get(`${agent}/${sessionId}`) ?? []));
  }

  list(agent: string): Promise<SessionInfo[]> {
    const prefix = `${agent}/`;
    const sessions: SessionInfo[] = [];
    for (const [key, entries] of this.#sessions) {
      if (key.startsWith(prefix) && entries.length) sessions.push(sessionInfo(agent, key.slice(prefix.length), entries));
    }
    return Promise.resolve(sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)));
  }

  delete(agent: string, sessionId: string): Promise<void> {
    this.#sessions.delete(`${agent}/${sessionId}`);
    return Promise.resolve();
  }
}
