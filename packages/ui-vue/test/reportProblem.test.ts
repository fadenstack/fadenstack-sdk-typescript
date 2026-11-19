// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MachinePolicy, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-vue";
import { FakeGateway, type FakeModel } from "@fadenstack/testing";

import { testServices } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

/** A governed panel; `supportEmail` is the machine policy's key. */
async function panel(options: Partial<AgentChatOptions> = {}, supportEmail?: string, model: FakeModel = () => ({ text: "ok" })) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .describeApp({ name: "Word add-in", version: "1.2.0" });
  if (supportEmail) builder.useMachinePolicy(MachinePolicy.from({ supportEmail }));
  const clipboard = new MemoryClipboard();
  const opened: string[] = [];
  const chat = new AgentChatViewModel(builder.build(), approvals, {
    ...testServices(), scheduler: immediateScheduler, clipboard, openLink: (url) => opened.push(url), automaticLanguage: "en", ...options,
  });
  await chat.initialize();
  const wrapper = mount(ChatPanel, { props: { chat }, attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return { chat, clipboard, opened, wrapper };
}

const button = (w: VueWrapper, name: string) => {
  const found = w.findAll("button").find((b) => (b.attributes("aria-label") ?? b.text()) === name);
  if (!found) throw new Error(`No button ${name}`);
  return found;
};

async function openFromAbout(wrapper: VueWrapper, settings = "Settings", about = "About", report = "Report a problem"): Promise<void> {
  await button(wrapper, settings).trigger("click");
  const item = wrapper.findAll("[role=menuitem]").find((i) => i.text() === about)!;
  await item.trigger("click");
  await button(wrapper, report).trigger("click");
}

describe("Report a problem (Vue)", () => {
  it("is a button beside Copy details in About, and opens a dialog in its place that takes the focus", async () => {
    const { wrapper } = await panel({}, "it-help@corp.example");
    await button(wrapper, "Settings").trigger("click");
    await wrapper.findAll("[role=menuitem]").find((i) => i.text() === "About")!.trigger("click");
    const row = wrapper.find(".fdn-about .fdn-report-actions");
    expect(row.findAll("button").map((b) => b.text())).toEqual(["Copy details", "Report a problem"]);
    await button(wrapper, "Report a problem").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=dialog][aria-label=About]").exists()).toBe(false);
    const sheet = wrapper.find("[role=dialog][aria-label='Report a problem']");
    expect(sheet.exists()).toBe(true);
    expect(document.activeElement).toBe(button(wrapper, "Close").element);
    expect(sheet.text()).toContain("This goes to it-help@corp.example.");
    expect(sheet.text()).toContain("This report contains:");
    expect(sheet.text()).toContain("Nothing from your chats is included.");
    const preview = sheet.find("textarea").element as HTMLTextAreaElement;
    expect(preview.readOnly).toBe(true);
    expect(preview.getAttribute("aria-label")).toBe("This report contains:");
    expect(preview.value.startsWith("What happened:\n\n\n-- \nApp: Word add-in 1.2.0\n")).toBe(true);
    expect(sheet.findAll("button").map((b) => b.attributes("aria-label") ?? b.text())).toEqual(["Close", "Write mail", "Copy details"]);
  });

  it("writes the mail through the host's openLink and copies the details with Copied", async () => {
    const { wrapper, chat, clipboard, opened } = await panel({}, "it-help@corp.example");
    await openFromAbout(wrapper);
    await button(wrapper, "Write mail").trigger("click");
    expect(opened).toEqual([chat.reportProblem.mailto]);
    expect(opened[0]!.startsWith("mailto:it-help@corp.example?subject=Problem%20with%20Word%20add-in%201.2.0")).toBe(true);
    await button(wrapper, "Copy details").trigger("click");
    await flushPromises();
    expect(clipboard.lastText!.startsWith("To: it-help@corp.example\nSubject: Problem with Word add-in 1.2.0 (Fadenstack SDK ")).toBe(true);
    expect(wrapper.find(".fdn-report .fdn-report-actions").text()).toContain("Copied");
  });

  it("closes with Escape and with Close, giving the focus back to the gear About was opened from", async () => {
    const { wrapper, chat } = await panel({}, "it-help@corp.example");
    await openFromAbout(wrapper);
    await button(wrapper, "Close").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
    expect(chat.isReportProblemOpen).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, "Settings").element);
    await openFromAbout(wrapper);
    await button(wrapper, "Close").trigger("click");
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, "Settings").element);
  });

  it("closes with a press outside it", async () => {
    const { wrapper, chat } = await panel({}, "it-help@corp.example");
    await openFromAbout(wrapper);
    document.querySelector(".fdn-composer textarea")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(chat.isReportProblemOpen).toBe(false);
  });

  it("governed without the key: no Write mail, the organisation's IT to ask, its Help link, and the copy without a To line", async () => {
    const { wrapper, clipboard } = await panel();
    await openFromAbout(wrapper);
    const sheet = wrapper.find("[role=dialog]");
    expect(wrapper.findAll("button").some((b) => b.text() === "Write mail")).toBe(false);
    expect(sheet.text()).toContain("Ask your organisation's IT for help. You can copy the details below for them.");
    expect(sheet.find("a").attributes("href")).toBe("https://faden.test/help/");
    await button(wrapper, "Copy details").trigger("click");
    await flushPromises();
    expect(clipboard.lastText!.startsWith("Subject: Problem with Word add-in 1.2.0 (Fadenstack SDK ")).toBe(true);
    expect(clipboard.lastText).not.toContain("To:");
  });

  it("is on a failed turn's error, adds its code, and gives the focus back to the link", async () => {
    const { wrapper, chat } = await panel({}, "it-help@corp.example", () => ({ badRequest: { code: "picture_type_not_allowed", message: "raw server text" } }));
    await chat.send("My secret question");
    await flushPromises();
    const link = wrapper.find(".fdn-status .fdn-link");
    expect(link.text()).toBe("Report a problem");
    expect(wrapper.find(".fdn-status").text()).toContain("Something went wrong");
    (link.element as HTMLElement).focus();
    await link.trigger("click");
    await flushPromises();
    const sheet = wrapper.find("[role=dialog]");
    const preview = sheet.find("textarea").element as HTMLTextAreaElement;
    expect(preview.value.split("\n").at(-1)).toBe("Error: picture_type_not_allowed");
    expect(sheet.text()).not.toContain("My secret question");
    await button(wrapper, "Close").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find(".fdn-status .fdn-link").element);
  });

  it("has no link on a turn that went well", async () => {
    const { wrapper, chat } = await panel();
    await chat.send("Hi");
    await flushPromises();
    expect(wrapper.find(".fdn-status .fdn-link").exists()).toBe(false);
    expect(wrapper.findAll("button").some((b) => b.text() === "Report a problem")).toBe(false);
  });

  it("speaks German: the button, the sheet and the mail's lines", async () => {
    const { wrapper } = await panel({ lockedLanguage: "de" }, "it@firma.example");
    await openFromAbout(wrapper, "Einstellungen", "Info", "Problem melden");
    const sheet = wrapper.find("[role=dialog]");
    expect(sheet.attributes("aria-label")).toBe("Problem melden");
    expect(sheet.text()).toContain("Das geht an it@firma.example.");
    expect(sheet.text()).toContain("Nichts aus Ihren Chats ist enthalten.");
    expect(sheet.findAll("button").map((b) => b.attributes("aria-label") ?? b.text())).toEqual(["Schließen", "E-Mail schreiben", "Details kopieren"]);
    expect((sheet.find("textarea").element as HTMLTextAreaElement).value.startsWith("Was ist passiert:\n")).toBe(true);
  });
});
