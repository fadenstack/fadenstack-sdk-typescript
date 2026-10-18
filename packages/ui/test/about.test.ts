import { describe, expect, it } from "vitest";

import { FadenstackClient, SDK_VERSION, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, type AppDescription } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  DEFAULT_REF_SOURCE,
  MemoryClipboard,
  MemoryPreferenceStore,
  aboutView,
  englishStrings,
  fadenstackLink,
  footerLink,
  germanStrings,
  helpLink,
  immediateScheduler,
  majorMinor,
  refSource,
  sdkName,
  serverAddress,
  type AgentChatOptions,
  type Clipboard,
} from "@fadenstack/ui";
import { FakeGateway, type FakeAgent } from "@fadenstack/testing";

/** The query of a link, as name-value pairs. */
const query = (href: string) => [...new URL(href).searchParams.entries()];
const sdkMinor = majorMinor(SDK_VERSION)!;

describe("refSource", () => {
  it.each(["sdk", "office", "chrome", "nextcloud", "desktop", "my-crm", "a1-b2-c3", "x".repeat(20)])("keeps %s", (value) => {
    expect(refSource(value)).toBe(value);
  });

  it.each([
    undefined, "", "Office", "my_crm", "my crm", "-crm", "crm-", "my--crm", "x".repeat(21), "acme.example.com", "ü", 42, null,
  ])("makes %s sdk", (value) => {
    expect(refSource(value)).toBe(DEFAULT_REF_SOURCE);
    expect(DEFAULT_REF_SOURCE).toBe("sdk");
  });
});

describe("majorMinor", () => {
  it.each([
    ["0.4.5", "0.4"], ["0.2.0-rc.3", "0.2"], ["1.12", "1.12"], ["v2.3.1", "2.3"], ["10.0.0+build.5", "10.0"], ["01.02.3", "1.2"],
  ])("makes %s %s", (version, expected) => {
    expect(majorMinor(version)).toBe(expected);
  });

  it.each([undefined, null, "", "1", "latest", "1.x", "1.2x"])("has none for %s", (version) => {
    expect(majorMinor(version)).toBeUndefined();
  });
});

describe("fadenstackLink", () => {
  it("carries ref and v, and nothing else", () => {
    expect(fadenstackLink("https://fadenstack.com/", "office-about", "0.2.0-rc.3")).toBe("https://fadenstack.com/?ref=office-about&v=0.2");
    expect(fadenstackLink("https://fadenstack.com/releases/?x=1#top", "sdk-panel", "0.4.5")).toBe("https://fadenstack.com/releases/?ref=sdk-panel&v=0.4");
    expect(query(fadenstackLink("https://developers.fadenstack.com/", "sdk-about"))).toEqual([["ref", "sdk-about"], ["v", sdkMinor]]);
  });

  it("leaves v out when the version has no major.minor", () => {
    expect(fadenstackLink("https://fadenstack.com/", "sdk-panel", null)).toBe("https://fadenstack.com/?ref=sdk-panel");
    expect(fadenstackLink("https://fadenstack.com/", "sdk-panel", "dev")).toBe("https://fadenstack.com/?ref=sdk-panel");
  });

  it("refuses a ref that is not a plain tag", () => {
    expect(() => fadenstackLink("https://fadenstack.com/", "user@example.com")).toThrow(RangeError);
    expect(() => fadenstackLink("https://fadenstack.com/", "a".repeat(41))).toThrow(RangeError);
  });
});

describe("the panel's links", () => {
  it("footer: the website with <app>-panel and the SDK's major.minor, sdk by default", () => {
    expect(footerLink()).toEqual({ label: "Fadenstack", href: `https://fadenstack.com/?ref=sdk-panel&v=${sdkMinor}` });
    expect(footerLink("office", "0.2.0-rc.3").href).toBe("https://fadenstack.com/?ref=office-panel&v=0.2");
    expect(footerLink("Not Allowed", "0.2.0").href).toBe("https://fadenstack.com/?ref=sdk-panel&v=0.2");
  });

  it("Help: the organisation's own server, without a ref; the address shown has no sign-in in it", () => {
    expect(helpLink("https://ai.example.internal")).toBe("https://ai.example.internal/help/");
    expect(helpLink(new URL("https://ai.example.internal/faden/"))).toBe("https://ai.example.internal/faden/help/");
    expect(helpLink("https://user:secret@ai.example.internal:8443/x?token=1#y")).toBe("https://ai.example.internal:8443/x/help/");
    expect(serverAddress("https://user:secret@ai.example.internal/?token=1")).toBe("https://ai.example.internal");
    expect(serverAddress("https://ai.example.internal/faden/")).toBe("https://ai.example.internal/faden");
  });

  it("names the SDK with its version and language", () => {
    expect(sdkName("0.2.0-rc.3")).toBe("Fadenstack SDK 0.2.0-rc.3 (TypeScript)");
    expect(sdkName()).toBe(`Fadenstack SDK ${SDK_VERSION} (TypeScript)`);
  });
});

describe("aboutView", () => {
  const facts = {
    agent: { name: "Contract helper", version: 3, draft: false, model: "qwen3.8-27b-fp8" },
    app: { name: "Word add-in", version: "1.4.0" },
    server: "https://ai.example.internal/",
    refSource: "office",
    sdkVersion: "0.2.0-rc.3",
  };

  it("shows the agent, its version and model, the app, the SDK and the server, with Help, the website and the docs", () => {
    const about = aboutView(facts, englishStrings);
    expect(about.agent).toBe("Contract helper");
    expect(about.agentDetails).toEqual(["Version 3", "Model: qwen3.8-27b-fp8"]);
    expect(about.environment).toEqual(["Runs in Word add-in 1.4.0", "Fadenstack SDK 0.2.0-rc.3 (TypeScript)", "Server: https://ai.example.internal"]);
    expect(about.links).toEqual([
      { label: "Help", href: "https://ai.example.internal/help/" },
      { label: "Fadenstack", href: "https://fadenstack.com/?ref=office-about&v=0.2" },
      { label: "Developer docs", href: "https://developers.fadenstack.com/?ref=office-about&v=0.2" },
    ]);
    expect(about.text).toBe([
      "Contract helper", "Version 3", "Model: qwen3.8-27b-fp8", "Runs in Word add-in 1.4.0", "Fadenstack SDK 0.2.0-rc.3 (TypeScript)",
      "Server: https://ai.example.internal",
    ].join("\n"));
  });

  it("says Draft for a draft, leaves out what it does not know, and speaks the panel's language", () => {
    const about = aboutView({ ...facts, agent: { ...facts.agent, draft: true, model: null }, app: undefined }, germanStrings);
    expect(about.agentDetails).toEqual(["Entwurf"]);
    expect(about.environment).toEqual(["Fadenstack SDK 0.2.0-rc.3 (TypeScript)", "Server: https://ai.example.internal"]);
    expect(about.links.map((l) => l.label)).toEqual(["Hilfe", "Fadenstack", "Entwicklerdokumentation"]);

    const early = aboutView({ sdkVersion: "0.2.0" }, englishStrings);
    expect(early.agent).toBe("");
    expect(early.agentDetails).toEqual([]);
    expect(early.links.map((l) => l.href)).toEqual(["https://fadenstack.com/?ref=sdk-about&v=0.2", "https://developers.fadenstack.com/?ref=sdk-about&v=0.2"]);
    expect(early.text).toBe("Fadenstack SDK 0.2.0 (TypeScript)");
  });

  it("puts nothing about the agent, the app, the user or the server into a link to fadenstack.com", () => {
    for (const link of aboutView(facts, englishStrings).links.filter((l) => l.href.includes("fadenstack.com"))) {
      expect(query(link.href).map(([name]) => name)).toEqual(["ref", "v"]);
      for (const secret of ["Contract", "Word", "qwen", "example", "internal"]) expect(link.href).not.toContain(secret);
    }
  });
});

async function chatWith(options: AgentChatOptions = {}, app?: AppDescription, agent: Partial<FakeAgent> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ...agent }], model: () => ({ text: "ok" }) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals);
  if (app) builder.describeApp(app);
  const clipboard = new MemoryClipboard();
  const chat = new AgentChatViewModel(builder.build(), approvals, {
    scheduler: immediateScheduler, clipboard, preferences: new MemoryPreferenceStore(), ...options,
  });
  return { chat, clipboard, gateway };
}

describe("AgentChatViewModel's About", () => {
  it("opens from the settings, closing them, and the settings close it again", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    chat.setSettingsOpen(true);
    chat.setAboutOpen(true);
    expect(chat.isAboutOpen).toBe(true);
    expect(chat.isSettingsOpen).toBe(false);
    chat.setSettingsOpen(true);
    expect(chat.isAboutOpen).toBe(false);
    chat.setAboutOpen(true);
    chat.setAboutOpen(false);
    expect(chat.isAboutOpen).toBe(false);
  });

  it("shows the agent from its profile, the app the host described, and the agent's server", async () => {
    const { chat, gateway } = await chatWith({ refSource: "chrome" }, { name: "Chrome extension", version: "1.3.0" }, { version: 4, model: "qwen3.8-27b-fp8" });
    await chat.initialize();
    expect(chat.agent.app).toEqual({ name: "Chrome extension", version: "1.3.0" });
    const about = chat.about;
    expect(about.agent).toBe("Page assistant");
    expect(about.agentDetails).toEqual(["Version 4", "Model: qwen3.8-27b-fp8"]);
    expect(about.environment).toEqual(["Runs in Chrome extension 1.3.0", `Fadenstack SDK ${SDK_VERSION} (TypeScript)`, `Server: ${gateway.serverUrl}`]);
    expect(about.links.map((l) => l.href)).toEqual([
      `${gateway.serverUrl}/help/`,
      `https://fadenstack.com/?ref=chrome-about&v=${sdkMinor}`,
      `https://developers.fadenstack.com/?ref=chrome-about&v=${sdkMinor}`,
    ]);
    expect(chat.footerLink!.href).toBe(`https://fadenstack.com/?ref=chrome-panel&v=${sdkMinor}`);
  });

  it("leaves out an app the host did not describe, and the agent before it started", async () => {
    const { chat } = await chatWith();
    expect(chat.agent.app).toBeUndefined();
    expect(chat.about.agent).toBe("");
    expect(chat.about.environment[0]).toBe(`Fadenstack SDK ${SDK_VERSION} (TypeScript)`);
    await chat.initialize();
    expect(chat.about.agentDetails).toEqual(["Version 1", "Model: fake-model"]);
    expect(chat.about.environment.some((line) => line.includes("Fadenstack SDK app"))).toBe(false);
  });

  it("copies the details as text lines", async () => {
    const { chat, clipboard, gateway } = await chatWith({}, { name: "Word add-in", version: "1.4.0" });
    await chat.initialize();
    expect(await chat.copyAboutDetails()).toBe(true);
    expect(clipboard.lastText).toBe(["Page assistant", "Version 1", "Model: fake-model", "Runs in Word add-in 1.4.0",
      `Fadenstack SDK ${SDK_VERSION} (TypeScript)`, `Server: ${gateway.serverUrl}`].join("\n"));
    const refusing: Clipboard = { setText: () => Promise.reject(new Error("No focus.")) };
    const second = await chatWith({ clipboard: refusing });
    expect(await second.chat.copyAboutDetails()).toBe(false);
  });

  it("keeps About but drops the footer link with branding false; a refSource that is not allowed is sdk", async () => {
    const { chat } = await chatWith({ branding: false, refSource: "Acme Corp" });
    await chat.initialize();
    expect(chat.footerLink).toBeUndefined();
    chat.setAboutOpen(true);
    expect(chat.isAboutOpen).toBe(true);
    expect(chat.about.links.map((l) => l.href).slice(1)).toEqual([
      `https://fadenstack.com/?ref=sdk-about&v=${sdkMinor}`, `https://developers.fadenstack.com/?ref=sdk-about&v=${sdkMinor}`,
    ]);
    const plain = await chatWith();
    expect(plain.chat.footerLink).toEqual({ label: "Fadenstack", href: `https://fadenstack.com/?ref=sdk-panel&v=${sdkMinor}` });
  });

  it("opens links through the host's openLink", async () => {
    const opened: string[] = [];
    const { chat } = await chatWith({ openLink: (url) => opened.push(url) });
    chat.openLink(chat.footerLink!.href);
    expect(opened).toEqual([chat.footerLink!.href]);
  });
});
