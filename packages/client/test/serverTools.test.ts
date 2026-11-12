import { describe, expect, it } from "vitest";

import { FadenstackApiError, FadenstackClient, FadenstackPermissionError, StaticTokenProvider, toAgentToolList, type FetchLike } from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";

// The organisation's MCP tools the server lists for the signed-in user (.NET AgentToolsTests).

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientFor(fetch: FetchLike): FadenstackClient {
  return new FadenstackClient({ serverUrl: "https://faden.test", agent: "excel", credentials: new StaticTokenProvider("t"), fetch });
}

describe("listTools", () => {
  it("lists the tools with whether each is allowed and switched on, from GET /v1/agents/{agent}/tools", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const client = clientFor(async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return json(200, { tools: [
        { name: "mcp.github.search", server: "github", description: "Searches code.", allowed: true, enabled: true },
        { name: "mcp.github.delete_repo", server: "github", description: "Deletes a repository.", allowed: false, enabled: true },
        { name: "mcp.time.now", server: "time", description: "The time.", allowed: true, enabled: false },
      ] });
    });
    expect(await client.agent!.listTools()).toEqual([
      { name: "mcp.github.search", server: "github", description: "Searches code.", allowed: true, enabled: true },
      { name: "mcp.github.delete_repo", server: "github", description: "Deletes a repository.", allowed: false, enabled: true },
      { name: "mcp.time.now", server: "time", description: "The time.", allowed: true, enabled: false },
    ]);
    expect(seen).toEqual([{ url: "https://faden.test/v1/agents/excel/tools", auth: "Bearer t" }]);
  });

  it("answers an empty list for a server with no tools, and null for one that cannot list them", async () => {
    expect(await clientFor(async () => json(200, { tools: [] })).agent!.listTools()).toEqual([]);
    expect(await clientFor(async () => json(404, { detail: "Not Found" })).agent!.listTools()).toBeNull(); // no route: a server from before the list
    expect(await clientFor(async () => json(404, { error: { code: "other", message: "x" } })).agent!.listTools()).toBeNull();
  });

  it("an unknown agent is still an error", async () => {
    const gone = clientFor(async () => json(404, { error: { code: "agent_not_found", message: "No agent 'excel'." } }));
    await expect(gone.agent!.listTools()).rejects.toMatchObject({ status: 404, code: "agent_not_found" });
    await expect(gone.agent!.listTools()).rejects.toBeInstanceOf(FadenstackApiError);
  });

  it("a forbidden user is an error, not an empty list", async () => {
    const forbidden = clientFor(async () => json(403, { error: { code: "permission_denied", message: "No." } }));
    await expect(forbidden.agent!.listTools()).rejects.toBeInstanceOf(FadenstackPermissionError);
  });

  it("never throws on what a server wrote: an entry without a name is left out, anything but true reads as no", () => {
    expect(toAgentToolList({ tools: [null, 3, {}, { name: "" }, { name: "a", allowed: "yes", enabled: 1, server: 5, description: null }, { name: "b", allowed: true }] }))
      .toEqual([{ name: "a", server: "", description: "", allowed: false, enabled: false }, { name: "b", server: "", description: "", allowed: true, enabled: false }]);
    for (const wire of [undefined, null, 7, "x", [], {}, { tools: "x" }, { tools: {} }]) expect(toAgentToolList(wire)).toEqual([]);
  });

  it("works against the fake server: listed when the agent has them, 404 as null when it does not", async () => {
    const gateway = new FakeGateway({ agents: [
      { slug: "listed", serverTools: [{ name: "mcp.time.now", server: "time", description: "The time.", enabled: false }] },
      { slug: "plain" },
    ] });
    const login = async (agent: string) => {
      const { loginWithPassword, AgentTokenProvider } = await import("@fadenstack/client");
      const tokens = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent, fetch: gateway.fetch });
      await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
      return new FadenstackClient({ serverUrl: gateway.serverUrl, agent, credentials: tokens, fetch: gateway.fetch });
    };
    expect(await (await login("listed")).agent!.listTools()).toEqual([{ name: "mcp.time.now", server: "time", description: "The time.", allowed: true, enabled: false }]);
    expect(await (await login("plain")).agent!.listTools()).toBeNull();
  });
});
