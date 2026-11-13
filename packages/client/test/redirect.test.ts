import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentPairing,
  AgentTokenProvider,
  FadenstackApiError,
  FadenstackClient,
  MemoryTokenStore,
  StaticTokenProvider,
  createAgent,
  loginWithPassword,
} from "@fadenstack/client";

// The SDK follows no redirect: a 307 or 308 would send the body again (chat text, a refresh token, a password, a pairing
// code) to wherever it points. A redirect is a typed error that names where it pointed, and nothing reaches the other
// address (sdk/51 I00 #7, item 14 and N4). Real sockets and the platform's fetch: another port is another origin.

let server: Server;
let elsewhere: Server;
let serverUrl: string;
let elsewhereUrl: string;
let reachedElsewhere: string[];

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<[Server, string]> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve([s, `http://127.0.0.1:${(s.address() as AddressInfo).port}/`]));
  });
}

beforeEach(async () => {
  reachedElsewhere = [];
  [elsewhere, elsewhereUrl] = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      reachedElsewhere.push(`${request.method} ${request.url} ${body}`);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  [server, serverUrl] = await listen((request, response) => {
    request.resume();
    response.writeHead(307, { location: new URL(request.url!.slice(1), elsewhereUrl).href, "content-length": "0" }).end();
  });
});

afterEach(() => {
  server.closeAllConnections();
  elsewhere.closeAllConnections();
  server.close();
  elsewhere.close();
});

async function refused(work: () => Promise<unknown>): Promise<void> {
  const error = await work().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(FadenstackApiError);
  expect((error as FadenstackApiError).status).toBe(307);
  expect((error as FadenstackApiError).code).toBe("redirect");
  expect((error as Error).message).toContain(new URL(elsewhereUrl).host); // where it pointed
  expect(reachedElsewhere).toEqual([]); // nothing was sent there
}

describe("a redirect", () => {
  it("is refused for an API call", async () => {
    const client = new FadenstackClient({ serverUrl, agent: "docs-assistant", credentials: new StaticTokenProvider("SECRET-TOKEN"), allowInsecureHttp: true });
    await refused(() => client.agent!.getProfile());
  });

  it("is refused for a chat, whose text never goes elsewhere", async () => {
    const client = new FadenstackClient({ serverUrl, agent: "docs-assistant", credentials: new StaticTokenProvider("SECRET-TOKEN"), allowInsecureHttp: true });
    await refused(async () => {
      for await (const _ of client.chat.stream([{ role: "user", content: "SECRET plan" }])) {
        // reading
      }
    });
  });

  it("is refused for a renewal, whose refresh token never goes elsewhere, and the sign-in is kept", async () => {
    const store = new MemoryTokenStore();
    const key = AgentTokenProvider.storeKey(serverUrl, "docs-assistant");
    await store.save(key, {
      accessToken: "a", accessExpiresAt: Date.now() - 60_000, refreshToken: "SECRET-REFRESH", refreshExpiresAt: Date.now() + 86_400_000,
      deviceId: "d", agentId: "a-1", agent: "docs-assistant",
    });
    const tokens = new AgentTokenProvider({ apiUrl: serverUrl, agent: "docs-assistant", store });
    await refused(() => tokens.getAccessToken());
    expect((await store.load(key))?.refreshToken).toBe("SECRET-REFRESH");
  });

  it("is refused for a password login, whose password never goes elsewhere", async () => {
    await refused(() => loginWithPassword({ apiUrl: serverUrl, email: "anna@example.com", password: "SECRET-PASSWORD" }));
  });

  it("is refused for creating an agent", async () => {
    await refused(() => createAgent({ apiUrl: serverUrl, loginToken: "SECRET-LOGIN", definition: { name: "Docs" } as never }));
  });

  it("is refused for a pairing", async () => {
    const pairing = new AgentPairing({ apiUrl: serverUrl });
    await refused(() => pairing.start("docs-assistant", "PC", { name: "Browser assistant", version: "1.0", os: "Chrome 140" }));
  });
});
