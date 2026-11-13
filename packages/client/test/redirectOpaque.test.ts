import { describe, expect, it } from "vitest";

import {
  AgentPairing,
  AgentTokenProvider,
  FadenstackApiError,
  FadenstackClient,
  MemoryTokenStore,
  StaticTokenProvider,
  createAgent,
  listModels,
  loginWithPassword,
  type FetchLike,
} from "@fadenstack/client";

// A browser answers `redirect: "manual"` with an opaque redirect: type "opaqueredirect", status 0, no headers, so where
// it pointed stays hidden (Fetch standard). Node shows the 3xx instead (redirect.test.ts), so this is the browser's shape
// played by a stand-in fetch: the typed redirect error, naming "another address", and no second request (sdk/51 I00 #7;
// owner, 13 Nov, item 3). OWASP ASVS 5.0 V12.

const serverUrl = "https://faden.test/";

function opaqueRedirect(): Response {
  return Object.defineProperties(new Response(null), {
    type: { value: "opaqueredirect" },
    status: { value: 0 },
    ok: { value: false },
    statusText: { value: "" },
  });
}

/** A browser's fetch that answers every request with an opaque redirect, and what it was asked. */
function browserFetch(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(`${init?.method ?? "GET"} ${url} redirect=${init?.redirect}`);
    return opaqueRedirect();
  };
  return { fetch, calls };
}

async function refused(calls: string[], work: () => Promise<unknown>): Promise<void> {
  const error = await work().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(FadenstackApiError);
  expect((error as FadenstackApiError).code).toBe("redirect");
  expect((error as FadenstackApiError).status).toBe(0);
  expect((error as Error).message).toContain("another address");
  expect(calls).toHaveLength(1); // nothing sent a second time, anywhere
  expect(calls[0]).toMatch(/ redirect=manual$/);
}

describe("a browser's opaque redirect", () => {
  it("is refused for an API call", async () => {
    const { fetch, calls } = browserFetch();
    const client = new FadenstackClient({ serverUrl, agent: "docs-assistant", credentials: new StaticTokenProvider("SECRET-TOKEN"), fetch });
    await refused(calls, () => client.agent!.getProfile());
  });

  it("is refused for a chat, whose text is not sent again", async () => {
    const { fetch, calls } = browserFetch();
    const client = new FadenstackClient({ serverUrl, agent: "docs-assistant", credentials: new StaticTokenProvider("SECRET-TOKEN"), fetch });
    await refused(calls, async () => {
      for await (const _ of client.chat.stream([{ role: "user", content: "SECRET plan" }])) {
        // reading
      }
    });
  });

  it("is refused for a renewal, and the sign-in is kept", async () => {
    const { fetch, calls } = browserFetch();
    const store = new MemoryTokenStore();
    const key = AgentTokenProvider.storeKey(serverUrl, "docs-assistant");
    await store.save(key, {
      accessToken: "a", accessExpiresAt: Date.now() - 60_000, refreshToken: "SECRET-REFRESH", refreshExpiresAt: Date.now() + 86_400_000,
      deviceId: "d", agentId: "a-1", agent: "docs-assistant",
    });
    const tokens = new AgentTokenProvider({ apiUrl: serverUrl, agent: "docs-assistant", store, fetch });
    await refused(calls, () => tokens.getAccessToken());
    expect((await store.load(key))?.refreshToken).toBe("SECRET-REFRESH");
  });

  it("is refused for a password login", async () => {
    const { fetch, calls } = browserFetch();
    await refused(calls, () => loginWithPassword({ apiUrl: serverUrl, email: "anna@example.com", password: "SECRET-PASSWORD", fetch }));
  });

  it("is refused for creating an agent and for listing models", async () => {
    const create = browserFetch();
    await refused(create.calls, () => createAgent({ apiUrl: serverUrl, loginToken: "SECRET-LOGIN", definition: { name: "Docs" } as never, fetch: create.fetch }));
    const models = browserFetch();
    await refused(models.calls, () => listModels({ serverUrl, loginToken: "SECRET-LOGIN", fetch: models.fetch }));
  });

  it("is refused for a pairing", async () => {
    const { fetch, calls } = browserFetch();
    const pairing = new AgentPairing({ apiUrl: serverUrl, fetch });
    await refused(calls, () => pairing.start("docs-assistant", "PC", { name: "Browser assistant", version: "1.0", os: "Chrome 140" }));
  });
});
