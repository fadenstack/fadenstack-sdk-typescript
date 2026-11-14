import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FadenstackApiError,
  FadenstackHttpsRequiredError,
  FadenstackUnreachableError,
  SERVER_CHECK_TIMEOUT_MS,
  checkServer,
  type FetchLike,
} from "@fadenstack/client";

// sdk/51 I15 §2 (Checking): does an address answer like a Fadenstack server. As .NET's ServerCheckTests.

function fake(answer: () => Response | Promise<Response>) {
  const sent: { url: URL; init: RequestInit }[] = [];
  const fetch: FetchLike = (input, init) => {
    sent.push({ url: new URL(String(input)), init: init ?? {} });
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

const ok = () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => { vi.useRealTimers(); });

describe("checkServer", () => {
  it("passes on a 200 with a JSON object, asking /api/health without credentials or redirects", async () => {
    const { fetch, sent } = fake(ok);

    await checkServer({ server: "https://faden.test", fetch });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.href).toBe("https://faden.test/api/health");
    expect(sent[0]!.init.method).toBe("GET");
    expect(sent[0]!.init.credentials).toBe("omit");
    expect(sent[0]!.init.redirect).toBe("manual");
    expect(sent[0]!.init.headers).toMatchObject({ accept: "application/json" });
  });

  it.each([
    ["a web page", () => new Response("<html>Welcome</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["a JSON array", () => new Response("[1,2]", { status: 200 })],
    ["a 404", () => new Response("{}", { status: 404 })],
    ["a 500", () => new Response("{}", { status: 500 })],
  ])("is not_fadenstack for %s", async (_name, answer) => {
    const { fetch } = fake(answer);

    const error = await checkServer({ server: "https://faden.test", fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackApiError);
    expect((error as FadenstackApiError).code).toBe("not_fadenstack");
    expect((error as Error).message).toBe("This address does not answer like a Fadenstack server.");
  });

  it("reports a redirect as redirect and does not follow it", async () => {
    const { fetch, sent } = fake(() => new Response(null, { status: 302, headers: { location: "https://other.test/api/health" } }));

    const error = await checkServer({ server: "https://faden.test", fetch }).catch((e: unknown) => e);

    expect((error as FadenstackApiError).code).toBe("redirect");
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["http://ai.example.test", false, true],
    ["http://localhost:8000", false, false],
    ["http://ai.example.test", true, false],
  ])("lets http go only to this machine or with allowInsecureHttp: %s (insecure %s, refused %s)", async (server, allowInsecureHttp, refused) => {
    const { fetch, sent } = fake(ok);

    const run = checkServer({ server, fetch, allowInsecureHttp });

    if (refused) {
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FadenstackHttpsRequiredError);
      expect(sent).toHaveLength(0);
    } else {
      await run;
      expect(sent).toHaveLength(1);
    }
  });

  it("calls a failing fetch unreachable", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError("Failed to fetch"));

    const error = await checkServer({ server: "https://faden.test", fetch: down }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackUnreachableError);
  });

  it("keeps the path the server sits under", async () => {
    const { fetch, sent } = fake(ok);

    await checkServer({ server: "https://x.test/faden/", fetch });
    await checkServer({ server: "https://x.test/faden", fetch });

    expect(sent.map((s) => s.url.href)).toEqual(["https://x.test/faden/api/health", "https://x.test/faden/api/health"]);
  });

  it("is unreachable when nothing answers within the time", async () => {
    vi.useFakeTimers();
    const silent: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); });
    });

    const result = checkServer({ server: "https://faden.test", fetch: silent }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SERVER_CHECK_TIMEOUT_MS + 1);
    const error = await result;

    expect(SERVER_CHECK_TIMEOUT_MS).toBe(15_000);
    expect(error).toBeInstanceOf(FadenstackUnreachableError);
    expect((error as Error).message).toContain("15 s");
  });

  it("rethrows the caller's own abort as it is", async () => {
    const controller = new AbortController();
    const silent: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(init.signal?.reason); });
    });
    const reason = new DOMException("stopped", "AbortError");

    const result = checkServer({ server: "https://faden.test", fetch: silent, signal: controller.signal }).catch((e: unknown) => e);
    controller.abort(reason);

    expect(await result).toBe(reason);
  });
});