import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, checkPicture, pictureTypeOf } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, builtInStrings, englishStrings, immediateScheduler } from "@fadenstack/ui";
import { FakeGateway, type FakeAgent, type FakeModel } from "@fadenstack/testing";
import { testServices } from "./services.js";

// A refused picture reaches the person in plain words, in five languages, in both modes (core 0.7.1 rc23): the gateway's three picture
// codes, and the check when a picture is attached. The .NET SDK's PictureRefusedTests.

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const b64 = (...bytes: number[]) => btoa(String.fromCharCode(...bytes));
const PNG = `data:image/png;base64,${b64(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)}`;
const JPEG = `data:image/jpeg;base64,${b64(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46)}`;
const GIF87 = `data:image/gif;base64,${b64(...[..."GIF87a"].map((c) => c.charCodeAt(0)), 1, 0)}`;
const GIF89 = `data:image/gif;base64,${b64(...[..."GIF89a"].map((c) => c.charCodeAt(0)), 1, 0)}`;
const WEBP = `data:image/webp;base64,${b64(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)}`;
const BMP = `data:image/bmp;base64,${b64(0x42, 0x4d, 0x36, 0, 0, 0, 0, 0)}`;
const TEXT = `data:image/png;base64,${btoa("this is not a picture")}`;

async function chat(model?: FakeModel, agent: Partial<FakeAgent> = { vision: true }) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ...agent }], ...(model ? { model } : {}) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const vm = new AgentChatViewModel(built, approvals, { ...testServices(), scheduler: immediateScheduler, locale: "en-GB" });
  await vm.initialize();
  return { vm, gateway };
}

describe("the check of a picture's first bytes", () => {
  it("knows PNG, JPEG, GIF87a, GIF89a and WebP, and nothing else", () => {
    for (const [url, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF87, "image/gif"], [GIF89, "image/gif"], [WEBP, "image/webp"]] as const) {
      expect(checkPicture(url)).toMatchObject({ ok: true, mediaType: type });
    }
    for (const url of [BMP, TEXT]) expect(checkPicture(url)).toEqual({ ok: false, reason: "type" });
    expect(pictureTypeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined(); // RIFF but WAVE
  });

  it("refuses empty data as missing", () => {
    for (const url of ["", "data:image/png;base64,", "data:image/png,", "  "]) expect(checkPicture(url)).toEqual({ ok: false, reason: "missing" });
  });

  it("goes by the bytes and not by what the URL claims, and says so in the URL it hands back", () => {
    const claimed = JPEG.replace("image/jpeg", "image/png");
    expect(checkPicture(claimed)).toMatchObject({ ok: true, mediaType: "image/jpeg", dataUrl: JPEG });
    const percent = "data:image/jpeg,%89PNG%0D%0A%1A%0A%00%00";
    expect(checkPicture(percent)).toMatchObject({ ok: true, mediaType: "image/png" });
  });
});

describe("attaching a picture", () => {
  it.each([["PNG", PNG], ["JPEG", JPEG], ["GIF87a", GIF87], ["GIF89a", GIF89], ["WebP", WEBP]])("takes a %s", async (_name, url) => {
    const { vm } = await chat();
    expect(vm.attachPicture({ dataUrl: url })).toBe(true);
    expect(vm.attachments).toHaveLength(1);
    expect(vm.error).toBeUndefined();
  });

  it.each(LANGUAGES)("refuses a BMP and text data with the sentence, in %s, and attaches nothing", async (language) => {
    const { vm } = await chat();
    await vm.setLanguage(language);
    const strings = builtInStrings[language]!;
    for (const url of [BMP, TEXT]) {
      expect(vm.attachPicture({ dataUrl: url })).toBe(false);
      expect(vm.error).toBe(strings.pictureTypeNotAllowed);
    }
    expect(vm.attachments).toEqual([]);
  });

  it("refuses an empty picture with its own sentence", async () => {
    const { vm } = await chat();
    expect(vm.attachPicture({ dataUrl: "data:image/png;base64," })).toBe(false);
    expect(vm.error).toBe("A picture in your message was empty, so nothing was sent.");
    expect(vm.attachments).toEqual([]);
  });

  it("sends the type the bytes show, not the URL's claim", async () => {
    const { vm, gateway } = await chat();
    expect(vm.attachPicture({ dataUrl: JPEG.replace("image/jpeg", "image/png") })).toBe(true);
    await vm.send("What is this?");
    const user = gateway.modelCalls.at(-1)!.messages.at(-1)!;
    expect(user.content).toEqual([{ type: "image_url", image_url: { url: JPEG } }, { type: "text", text: "What is this?" }]);
  });

  it("checks a picture a host added as an attachment again when the message goes, and sends nothing of it", async () => {
    const { vm, gateway } = await chat();
    vm.attach({ title: "Clipboard", content: BMP, kind: "picture", mediaType: "image/png" });
    await vm.send("Look at this");
    const user = gateway.modelCalls.at(-1)!.messages.at(-1)!;
    expect(JSON.stringify(user.content)).not.toContain("image_url");
    const notice = vm.turns[0]!.parts.find((p) => p.kind === "notice");
    expect(notice).toBeDefined();
  });
});

describe("a picture the gateway refused", () => {
  it.each([
    ["picture_type_not_allowed", "pictureTypeNotAllowed"],
    ["picture_missing", "pictureMissing"],
    ["embeds_not_allowed", "embedsNotAllowed"],
  ] as const)("says %s in plain words, in five languages", async (code, key) => {
    for (const language of LANGUAGES) {
      const { vm } = await chat(() => ({ badRequest: { code, param: "messages.0.content.1", message: "raw server text" } }));
      await vm.setLanguage(language);
      await vm.send("Hi");
      const turn = vm.turns[0]!;
      expect(turn.state).toBe("failed");
      expect(turn.errorMessage).toBe(builtInStrings[language]![key]);
      expect(turn.errorMessage).not.toContain("raw server text");
    }
  });

  it("has the English sentences the owner suggested", () => {
    expect(englishStrings.pictureTypeNotAllowed).toBe("This picture's format can't be sent. Use a PNG, JPEG, WebP or GIF picture.");
    expect(englishStrings.pictureMissing).toBe("A picture in your message was empty, so nothing was sent.");
    expect(englishStrings.embedsNotAllowed).toBe("The server does not accept pictures in this form.");
  });

  it("keeps the server's own text for another 400", async () => {
    const { vm } = await chat(() => ({ badRequest: { code: "something_else", message: "Not ours." } }));
    await vm.send("Hi");
    expect(vm.turns[0]!.errorMessage).toBe("Not ours.");
  });
});
