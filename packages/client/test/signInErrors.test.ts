import { describe, expect, it } from "vitest";

import {
  EndpointUnreachableError,
  FadenstackApiError,
  FadenstackBadCredentialsError,
  FadenstackClient,
  FadenstackHttpsRequiredError,
  FadenstackUnreachableError,
  loginWithPassword,
  type FetchLike,
} from "@fadenstack/client";

// sdk/51 I15 step 1 (§4): the sign-in's typed errors, as .NET's SignInErrorTests. A certificate error is .NET only: a
// browser does not say.

const API = "https://faden.test";

/** A fetch that answers with `answer` and keeps what it was asked. */
function fake(answer: () => Response) {
  const sent: { url: URL; init: RequestInit }[] = [];
  const fetch: FetchLike = (input, init) => {
    sent.push({ url: new URL(String(input)), init: init ?? {} });
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the password login's answers", () => {
  it("gives the login token and sends the form once", async () => {
    const { fetch, sent } = fake(() => json({ access_token: "login-jwt", token_type: "bearer" }));

    const token = await loginWithPassword({ apiUrl: API, email: "ana@example.test", password: "s3cret", fetch });

    expect(token).toBe("login-jwt");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.href).toBe("https://faden.test/api/auth/jwt/login");
    expect(sent[0]!.init.body).toBe("username=ana%40example.test&password=s3cret");
  });

  it("makes a wrong password its own error, and never says the password", async () => {
    const { fetch } = fake(() => json({ detail: "LOGIN_BAD_CREDENTIALS" }, 400));

    const error = await loginWithPassword({ apiUrl: API, email: "ana@example.test", password: "wrong-pw", fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackBadCredentialsError);
    expect(error).toBeInstanceOf(FadenstackApiError); // what was thrown before, so existing catches keep working
    expect((error as FadenstackBadCredentialsError).code).toBe("LOGIN_BAD_CREDENTIALS");
    expect((error as FadenstackBadCredentialsError).status).toBe(400);
    expect((error as Error).message).toBe("The e-mail or password is not right.");
    expect((error as Error).message).not.toContain("wrong-pw");
    expect((error as Error).name).toBe("FadenstackBadCredentialsError");
  });

  it("calls a web page where the API should be not_fadenstack", async () => {
    const { fetch } = fake(() => new Response("<html>Welcome</html>", { status: 200, headers: { "content-type": "text/html" } }));

    const error = await loginWithPassword({ apiUrl: API, email: "a@b.test", password: "p", fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FadenstackApiError);
    expect((error as FadenstackApiError).code).toBe("not_fadenstack");
  });

  it.each([
    ["http://ai.example.test", false, true],
    ["http://localhost:8000", false, false],
    ["http://ai.example.test", true, false],
  ])("sends a password only over https or to this machine: %s (insecure %s, refused %s)", async (apiUrl, allowInsecureHttp, refused) => {
    const { fetch, sent } = fake(() => json({ access_token: "t" }));

    const run = loginWithPassword({ apiUrl, email: "a@b.test", password: "p", fetch, allowInsecureHttp });

    if (refused) {
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FadenstackHttpsRequiredError);
      expect(error).toBeInstanceOf(TypeError); // still a TypeError for the callers that catch that
      expect((error as Error).name).toBe("FadenstackHttpsRequiredError");
      expect(sent).toHaveLength(0);
    } else {
      expect(await run).toBe("t");
    }
  });

  it("never takes the password along on a redirect", async () => {
    const { fetch, sent } = fake(() => new Response(null, { status: 307, headers: { location: "https://evil.example/api/auth/jwt/login" } }));

    const error = await loginWithPassword({ apiUrl: API, email: "a@b.test", password: "p", fetch }).catch((e: unknown) => e);

    expect((error as FadenstackApiError).code).toBe("redirect");
    expect(sent).toHaveLength(1);
  });

  it("calls nothing answering unreachable", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError("Failed to fetch"));

    await expect(loginWithPassword({ apiUrl: API, email: "a", password: "p", fetch: down })).rejects.toBeInstanceOf(FadenstackUnreachableError);
  });
});

describe("the other typed errors", () => {
  it("the client transport refuses plain http with the typed error, still a TypeError", () => {
    const make = () => new FadenstackClient({ serverUrl: "http://ai.example.test", agent: "a" });
    expect(make).toThrow(FadenstackHttpsRequiredError);
    expect(make).toThrow(TypeError);
  });

  it("a URL that does not parse, or another scheme, stays a plain TypeError", () => {
    for (const serverUrl of ["not a url", "ftp://faden.test"]) {
      const error = (() => { try { new FadenstackClient({ serverUrl, agent: "a" }); } catch (e) { return e; } })();
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(FadenstackHttpsRequiredError);
    }
  });

  it("an endpoint's unreachable is also the server's kind", () => {
    expect(new EndpointUnreachableError("x")).toBeInstanceOf(FadenstackUnreachableError);
  });
});