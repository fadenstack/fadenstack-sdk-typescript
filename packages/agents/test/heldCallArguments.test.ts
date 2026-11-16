import { describe, expect, it } from "vitest";

import { lastToolResults, type FakeReply } from "@fadenstack/testing";

import { gatewayArguments } from "../src/session.js";
import { setup } from "./helpers.js";

/**
 * The card of a call the gateway holds shows the call's arguments (core 0.7.1 rc22): the members of the JSON object when the text is
 * complete, else the text as one read-only value that the card says is shortened. An older gateway sends none: the card stays as it was.
 * Port of the .NET HeldCallArgumentsTests.
 */
describe("the arguments of a call the gateway holds", () => {
  type Event = { arguments?: string; argumentsTruncated?: true; argumentsSha256?: string };

  async function asked(event: Event) {
    const s = await setup({
      model: (request): FakeReply => (lastToolResults(request).size ? { text: "Done." }
        : { text: "Commenting.", gatewayTool: { name: "mcp.github.comment", arguments: { title: "x" }, approval: { rule: true, toolClass: "write", argumentsEvent: event } } }),
    });
    await (await s.agent.startSession("ask")).send("Comment.");
    return s.asked.find((r) => r.source === "gateway")!;
  }

  it("fills the arguments from a complete JSON object, like the app's own calls", async () => {
    const request = await asked({ arguments: '{"title":"x","page":2,"labels":["a","b"]}' });

    expect(request.argumentsShortened).toBeUndefined();
    expect(request.arguments).toEqual({ title: "x", page: 2, labels: ["a", "b"] });
    expect(Object.isFrozen(request.arguments)).toBe(true);
  });

  it("shows a cut text as one read-only value and says it is shortened", async () => {
    const request = await asked({ arguments: '{"title":"x', argumentsTruncated: true, argumentsSha256: "a".repeat(64) });

    expect(request.argumentsShortened).toBe(true);
    expect(request.arguments).toEqual({ arguments: '{"title":"x' });
  });

  it("shows a cut text that would parse as text too", async () => {
    const request = await asked({ arguments: '{"title":"x"}', argumentsTruncated: true });

    expect(request.argumentsShortened).toBe(true);
    expect(request.arguments).toEqual({ arguments: '{"title":"x"}' });
  });

  it.each(["not json at all", "[1,2]", '"text"', "42"])("shows text that is not a JSON object as one value: %s", async (text) => {
    const request = await asked({ arguments: text });

    expect(request.argumentsShortened).toBe(true);
    expect(request.arguments).toEqual({ arguments: text });
  });

  it("cuts text longer than the gateway's cap here too", () => {
    const shown = gatewayArguments({ arguments: "x".repeat(9000) });

    expect(shown.shortened).toBe(true);
    expect((shown.arguments["arguments"] as string).length).toBe(8000);
  });

  it.each([{}, { arguments: "" }])("an older gateway sends none and the card stays as it was: %j", async (event) => {
    const request = await asked(event);

    expect(request.argumentsShortened).toBeUndefined();
    expect(request.arguments).toEqual({});
  });
});
