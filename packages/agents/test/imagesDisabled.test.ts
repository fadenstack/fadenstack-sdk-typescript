import { afterEach, describe, expect, it } from "vitest";

import { EndpointDialect, FadenstackApiError, ErrorCodes, isImagesDisabled, type ChatMessage } from "@fadenstack/client";
import {
  AgentDefinition,
  FadenstackAgent,
  MemoryApprovalStore,
  MemorySessionStore,
  defineTool,
  type AgentEvent,
} from "@fadenstack/agents";
import { OpenAiFake, type FakeModel, type FakeModelRequest } from "@fadenstack/testing";

import { PAGE_CONTRACT, collect, setup, type Setup } from "./helpers.js";

// Image generation is off in core 0.7.1 (EU AI Act, Article 5): a tool that makes pictures is hidden while the agent has no
// pictures (`imagesAvailable`), and a refusal with `images_disabled` reaches the model and the person. The .NET SDK's
// ImagesDisabledTests.

const MODEL_TEXT = "Image generation is turned off in this version (EU AI Act, Article 5). Do not try again.";
const CONTRACT = [...PAGE_CONTRACT, { name: "insert_image", risk: "write" as const }];

const ran: string[] = [];
let current: Setup | undefined;

/** An app's picture tool: it asks the server's images route, as the Office add-ins' `insert_image` does. */
const insertImage = defineTool<{ prompt: string }>({
  name: "insert_image", description: "Inserts a picture made from a prompt.", toolClass: "write", makesPictures: true,
  parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  run: async ({ prompt }) => {
    ran.push("insert_image");
    const { client } = current!;
    return client.transport.post(client.transport.gateway("v1/agents/docs/images/generations"), { prompt });
  },
});

/** Builds the agent; the model is asked each round with the tools it was offered written down. */
async function start(images: boolean, model: FakeModel, offered: string[][]) {
  ran.length = 0;
  const s = await setup({ agents: [{ slug: "docs", contract: CONTRACT, images }],
    model: (request: FakeModelRequest) => { offered.push(request.tools.map((t) => t.name).sort()); return model(request); } },
  undefined, (b) => b.addTools(insertImage));
  current = s;
  return s;
}

const callsOnce = (...names: string[]): FakeModel => (request) =>
  request.messages.some((m: ChatMessage) => m.role === "tool") ? { text: "Done." }
    : { text: "On it.", toolCalls: names.map((name, i) => ({ name, id: `call-${i}`, arguments: { prompt: "a cat", page: 7 } })) };

const notices = (events: AgentEvent[]) => events.filter((e) => e.type === "notice");

afterEach(() => { current = undefined; });

describe("tools that make pictures", () => {
  it("are offered when the profile says images", async () => {
    const offered: string[][] = [];
    const s = await start(true, () => ({ text: "Hello." }), offered);
    await (await s.agent.startSession("auto")).send("Hi");
    expect(s.agent.imagesAvailable).toBe(true);
    expect(offered[0]).toEqual(["delete_page", "insert_image", "read_page", "write_page"]);
  });

  it("are hidden when the profile says no images, and stay registered", async () => {
    const offered: string[][] = [];
    const s = await start(false, () => ({ text: "Hello." }), offered);
    await (await s.agent.startSession("auto")).send("Hi");
    expect(s.agent.imagesAvailable).toBe(false);
    expect(offered[0]).not.toContain("insert_image");
    expect(s.agent.tools.map((t) => t.name)).toContain("insert_image");
    expect(s.agent.tools.find((t) => t.name === "insert_image")!.makesPictures).toBe(true);
  });

  it("are refused as unknown, and do not run, when a call arrives while they are hidden", async () => {
    const offered: string[][] = [];
    const s = await start(false, callsOnce("insert_image"), offered);
    const events = await collect((await s.agent.startSession("auto")).stream("A cat, please."));
    expect(ran).toEqual([]);
    expect(events.find((e) => e.type === "tool_completed")).toMatchObject({ outcome: "error", result: "Tool 'insert_image' does not exist here." });
    expect(s.gateway.requests.some((r) => r.path.endsWith("/images/generations"))).toBe(false);
  });

  it("follow a profile that flips images, from the next session on", async () => {
    const offered: string[][] = [];
    const s = await start(true, () => ({ text: "Ok." }), offered);
    const now = Date.now();
    s.agent.clock = () => now;
    await (await s.agent.startSession("auto")).send("1");
    s.gateway.updateAgent("docs", { images: false });
    s.agent.clock = () => now + 61_000;
    await (await s.agent.startSession("auto")).send("2");
    s.gateway.updateAgent("docs", { images: true });
    s.agent.clock = () => now + 122_000;
    await (await s.agent.startSession("auto")).send("3");
    expect(offered.map((o) => o.includes("insert_image"))).toEqual([true, false, true]);
  });

  it("are not offered to a standalone agent", async () => {
    const fake = new OpenAiFake();
    const agent = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "docs", version: { host_tool_contract: [{ name: "insert_image", risk: "write" }] } }))
      .useSessionStore(new MemorySessionStore())
      .useApprovalStore(new MemoryApprovalStore())
      .addTools(insertImage)
      .build();
    const session = await agent.startSession("auto");
    expect(agent.imagesAvailable).toBe(false);
    expect(agent.offer("auto", session).map((t) => t.name)).toEqual([]);
    expect(agent.find("insert_image")).toBeUndefined();
    expect(agent.tools.map((t) => t.name)).toEqual(["insert_image"]);
  });
});

describe("a refusal with images_disabled", () => {
  it("tells the model, raises one notice per turn, and hides the picture tools from the next round", async () => {
    const offered: string[][] = [];
    const s = await start(true, callsOnce("insert_image", "insert_image"), offered);
    const session = await s.agent.startSession("auto");
    const events = await collect(session.stream("A cat and a dog."));

    expect(ran).toEqual(["insert_image"]); // the second call of the round meets the tool already hidden
    const completed = events.filter((e) => e.type === "tool_completed");
    expect(completed.map((e) => [(e as { outcome: string }).outcome, (e as { result: string }).result])).toEqual([["error", MODEL_TEXT], ["error", MODEL_TEXT]]);
    expect(notices(events)).toEqual([{ type: "notice", turnId: expect.any(String), notice: {
      outcome: "images_disabled", stage: "tool", category: "images", message: expect.stringContaining("Article 5") } }]);
    expect(s.agent.imagesAvailable).toBe(false);
    expect(offered[0]).toContain("insert_image");
    expect(offered[1]).not.toContain("insert_image"); // the round after the refusal

    await session.send("Again?");
    expect(offered[2]).not.toContain("insert_image"); // and the next turn
    expect(s.gateway.requests.filter((r) => r.path.endsWith("/images/generations"))).toHaveLength(1);
  });

  it("is told apart from other 403s by the client's check", () => {
    const refused = new FadenstackApiError(403, "Off.", { code: "images_disabled", type: "invalid_request_error" });
    expect([refused.isImagesDisabled, isImagesDisabled(refused), ErrorCodes.imagesDisabled]).toEqual([true, true, "images_disabled"]);
    expect(isImagesDisabled(new Error("outer", { cause: refused }))).toBe(true);
    expect(isImagesDisabled(new FadenstackApiError(403, "No.", { code: "agent_not_granted", type: "permission_error" }))).toBe(false);
    expect(isImagesDisabled(new FadenstackApiError(403, "No."))).toBe(false);
    expect(isImagesDisabled(new FadenstackApiError(400, "Off.", { code: "images_disabled" }))).toBe(false);
    expect(isImagesDisabled("images_disabled")).toBe(false);
    expect(isImagesDisabled(undefined)).toBe(false);
  });
});
