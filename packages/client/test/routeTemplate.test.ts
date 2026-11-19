import { describe, expect, it } from "vitest";

import { DirectChatClient, EndpointDialect, StaticTokenProvider, type LogEvent } from "@fadenstack/client";
import { OpenAiFake } from "@fadenstack/testing";

import { routeTemplate } from "../src/http/routeTemplate.js";

// The route a request is logged with (0.3.1): plain words stay, every other segment is `{id}`, as the .NET SDK's RouteTemplate
// does (LoggingTests.A_route_keeps_plain_words_and_hides_the_rest, the same cases). The browser log and "Report a problem"'s
// "Copy details" carry the route, so an id, a file name or a key in an endpoint's base path must never be in it.

describe("the logged route", () => {
  it.each([
    ["https://x.test/v1/agents/docs-assistant/chat/completions?stream=1", "/v1/agents/docs-assistant/chat/completions"],
    ["https://x.test/v1/sessions/0f3a/messages/42", "/v1/sessions/{id}/messages/{id}"],
    ["https://x.test/api/agent-tokens/refresh", "/api/agent-tokens/refresh"],
    ["https://x.test/v1/files/Quarterly%20Report.docx", "/v1/files/{id}"],
    ["https://x.test/", "/"],
    ["https://proxy.example.test/Kx9fQ2abc/v1/chat/completions", "/{id}/v1/chat/completions"],
  ])("keeps plain words and hides the rest: %s", (url, template) => {
    expect(routeTemplate(new URL(url))).toBe(template);
  });

  it("an endpoint whose base path holds a key logs the template, never the key", async () => {
    const fake = new OpenAiFake();
    const events: LogEvent[] = [];
    const client = new DirectChatClient({
      baseUrl: "https://proxy.example.test/Kx9fQ2abc/v1", model: "qwen3:14b", dialect: EndpointDialect.openAiCompatible,
      key: new StaticTokenProvider("k-123"), fetch: fake.fetch, logger: { log: (e) => events.push(e) },
    });

    for await (const _ of client.stream([{ role: "user", content: "Hi" }])) {
      // read to the end
    }

    const requests = events.filter((e) => e.eventName === "Request");
    expect(requests.map((e) => e.fields["Route"])).toEqual(["/{id}/v1/chat/completions"]);
    expect(JSON.stringify(events)).not.toContain("Kx9fQ2abc");
    expect(fake.requests[0]!.url.pathname).toBe("/Kx9fQ2abc/v1/chat/completions"); // the request itself still goes there
  });
});
