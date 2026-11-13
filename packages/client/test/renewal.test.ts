import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentTokenProvider, MemoryTokenStore, type LockManagerLike, type TokenSet } from "@fadenstack/client";

// Two contexts keep the same agent sign-in (a browser extension's side panel and its service worker share
// chrome.storage): the refresh token changes on every renewal, and the server ends the whole sign-in when an old one
// comes back. So one context renews at a time (Web Locks), and the other takes the renewed sign-in from the store
// (sdk/51 I00 #2, N1).

const API = "https://faden.test/";
const AGENT = "docs-assistant";
const KEY = AgentTokenProvider.storeKey(API, AGENT);

/** A sign-in whose access token has expired and whose refresh token is still good. */
function expired(): TokenSet {
  return {
    accessToken: "access-1", accessExpiresAt: Date.now() - 60_000, refreshToken: "refresh-1", refreshExpiresAt: Date.now() + 86_400_000,
    deviceId: "device-1", agentId: "agent-1", agent: AGENT,
  };
}

/** The backend's refresh route: each refresh token works once; one that comes back ends the sign-in. */
function rotatingServer(takesMs: number) {
  let valid: string | undefined = "refresh-1";
  let issued = 1;
  const counts = { renewals: 0, reused: 0 };
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const presented = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token;
    await new Promise((resolve) => setTimeout(resolve, takesMs)); // long enough for the other context to try meanwhile
    if (presented !== valid) {
      counts.reused++;
      valid = undefined; // reuse detection: the whole sign-in ends
      return Response.json({ detail: { code: "refresh_reused", message: "Signed out." } }, { status: 401 });
    }
    counts.renewals++;
    issued++;
    valid = `refresh-${issued}`;
    return Response.json({
      access_token: `access-${issued}`, expires_in: 600, refresh_token: valid, refresh_expires_in: 86_400,
      device_id: "device-1", agent_id: "agent-1", agent: AGENT,
    });
  };
  return { fetch, counts };
}

/** The Web Locks API's promise, as navigator.locks keeps it: one holder per name, in the order asked. */
class Locks implements LockManagerLike {
  readonly #tails = new Map<string, Promise<void>>();
  readonly names: string[] = [];

  async request<T>(name: string, _options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    this.names.push(name);
    const previous = this.#tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    this.#tails.set(name, previous.then(() => new Promise<void>((resolve) => (release = resolve))));
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The platform's LockManager fits LockManagerLike as it is (checked by the compiler; Node 20 has no navigator.locks).
export const platformLocksFit: (locks: LockManager) => LockManagerLike = (locks) => locks;

describe("renewing one sign-in from two contexts", () => {
  it("renews once when both renew at the same moment, and both keep the sign-in", async () => {
    const store = new MemoryTokenStore(); // chrome.storage, shared by both
    await store.save(KEY, expired());
    const server = rotatingServer(150);
    const locks = new Locks();
    const panel = new AgentTokenProvider({ apiUrl: API, agent: AGENT, store, fetch: server.fetch, locks });
    const worker = new AgentTokenProvider({ apiUrl: API, agent: AGENT, store, fetch: server.fetch, locks });

    const tokens = await Promise.all([panel.getAccessToken(), worker.getAccessToken()]);

    expect(server.counts).toEqual({ renewals: 1, reused: 0 });
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect((await store.load(KEY))?.refreshToken).toBe("refresh-2");
    expect(locks.names).toEqual([`fadenstack.renewal:${KEY}`, `fadenstack.renewal:${KEY}`]);
  });

  it("takes the sign-in another context renewed instead of renewing with the old refresh token", async () => {
    const store = new MemoryTokenStore();
    await store.save(KEY, expired());
    const server = rotatingServer(0);
    const panel = new AgentTokenProvider({ apiUrl: API, agent: AGENT, store, fetch: server.fetch, locks: null });
    const worker = new AgentTokenProvider({ apiUrl: API, agent: AGENT, store, fetch: server.fetch, locks: null });
    expect(await worker.isSignedIn()).toBe(true); // the worker has read the old sign-in

    expect(await panel.getAccessToken()).toBe("access-2");
    expect(await worker.getAccessToken()).toBe("access-2");

    expect(server.counts).toEqual({ renewals: 1, reused: 0 });
  });

  it("uses the platform's navigator.locks when the app gives none", async () => {
    const locks = new Locks();
    vi.stubGlobal("navigator", { locks });
    const store = new MemoryTokenStore();
    await store.save(KEY, expired());
    const server = rotatingServer(0);

    await new AgentTokenProvider({ apiUrl: API, agent: AGENT, store, fetch: server.fetch }).getAccessToken();

    expect(locks.names).toEqual([`fadenstack.renewal:${KEY}`]);
  });
});
