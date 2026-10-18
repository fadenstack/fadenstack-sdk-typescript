// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { h, nextTick } from "vue";

import { SDK_VERSION } from "@fadenstack/client";
import { ToolCallPart, majorMinor, stringsFor, type AgentChatOptions, type AgentChatViewModel } from "@fadenstack/ui";
import { ChatPanel, ToolCallView, type PartRenderer } from "@fadenstack/ui-vue";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";

import { chatWith, waitUntil } from "./helpers.js";
import HostPanel from "./HostPanel.vue";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

async function panel(model: FakeModel, options: AgentChatOptions = {}, risk: "write" | "destructive" = "write",
  mountOptions: { props?: Record<string, unknown>; slots?: Record<string, () => unknown> } = {}) {
  const setup = await chatWith(model, options, risk);
  const wrapper = mount(ChatPanel, { props: { chat: setup.chat, ...mountOptions.props }, slots: mountOptions.slots, attachTo: document.body });
  wrappers.push(wrapper);
  return { ...setup, wrapper };
}

/** Lets the agent run and the panel catch up. */
async function settle(chat: AgentChatViewModel): Promise<void> {
  await waitUntil(() => !chat.isBusy);
  await flushPromises();
}

const button = (w: VueWrapper, name: string | RegExp) => {
  const found = w.findAll("button").find((b) => {
    const label = b.attributes("aria-label") ?? b.text();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`No button ${String(name)}`);
  return found;
};

const fillsThenAnswers: FakeModel = (r) => (lastToolResults(r).size ? { text: "Filled in." }
  : { toolCalls: [{ name: "fill_field", arguments: { value: "Jane" } }] });

describe("ChatPanel (Vue)", () => {
  it("shows the agent's greeting and suggestions, follows the browser's theme, and says its language", async () => {
    const { wrapper } = await panel(() => ({ text: "ok" }));
    expect(wrapper.find(".fdn-header-title").text()).toBe("Page assistant");
    expect(wrapper.find(".fdn-greeting").text()).toBe("I read the page you are on.");
    expect(button(wrapper, "Summarise this page").exists()).toBe(true);
    expect(wrapper.attributes()).toMatchObject({ "data-theme": "system", lang: "en", dir: "ltr" });
    expect(wrapper.find(".fdn-empty-mark .fdn-agent-avatar").exists()).toBe(true);
  });

  it("sends with Enter and renders the answer as Markdown, never as HTML", async () => {
    const { wrapper, chat } = await panel(() => ({ text: "**Bold** and <b>not bold</b>\n\n```js\nlet x = 1;\n```" }));
    const box = wrapper.find("textarea");
    await box.setValue("Hello");
    await box.trigger("keydown", { key: "Enter" });
    await settle(chat);
    expect(wrapper.find(".fdn-md strong").text()).toBe("Bold");
    expect(wrapper.find(".fdn-user-bubble").text()).toBe("Hello");
    expect(wrapper.find(".fdn-md b").exists()).toBe(false);
    expect(wrapper.find(".fdn-md").text()).toContain("<b>not bold</b>");
    expect(wrapper.find(".fdn-md-code code").text()).toBe("let x = 1;");
    expect(button(wrapper, "Copy code").exists()).toBe(true);
    expect((box.element as HTMLTextAreaElement).value).toBe("");
  });

  it("copies a table of an answer for a spreadsheet, and shows it was copied", async () => {
    const { wrapper, chat, clipboard } = await panel(() => ({ text: "| Task | Interval |\n|---|---|\n| Seal check | 2 000 h |" }));
    await wrapper.find("textarea").setValue("Intervals?");
    await button(wrapper, "Send").trigger("click");
    await settle(chat);
    await button(wrapper, "Copy table").trigger("click");
    expect(clipboard.lastText).toBe("Task\tInterval\nSeal check\t2 000 h");
    expect(clipboard.lastHtml).toContain("<td>Seal check</td>");
    expect(button(wrapper, "Copy table").attributes("title")).toBe("Copied");
  });

  it("asks with a card and runs the tool when Allow is clicked", async () => {
    const { wrapper, chat, filled } = await panel(fillsThenAnswers);
    await wrapper.find("textarea").setValue("Fill my name");
    await button(wrapper, "Send").trigger("click");
    await waitUntil(() => wrapper.find(".fdn-approval").exists());
    expect(wrapper.find(".fdn-approval strong").text()).toBe("Run fill_field?");
    expect(wrapper.find(".fdn-approval-target").text()).toBe('textbox "Name" on example.com');
    expect(wrapper.find(".fdn-approval-args").text()).toBe("value: Jane");
    await button(wrapper, "Allow").trigger("click");
    await settle(chat);
    expect(wrapper.text()).toContain("Filled in.");
    expect(filled).toEqual(["Jane"]);
    expect(wrapper.find(".fdn-approval-state").text()).toBe("Allowed");
    expect(wrapper.text()).toContain("Ran fill_field");
  });

  it("offers Allow for this chat and Allow always for a tool that changes something", async () => {
    const { wrapper, chat } = await panel(fillsThenAnswers);
    await wrapper.find("textarea").setValue("Fill my name");
    await button(wrapper, "Send").trigger("click");
    await waitUntil(() => wrapper.find(".fdn-approval").exists());
    expect(button(wrapper, "Allow for this chat").exists()).toBe(true);
    await button(wrapper, "Allow always").trigger("click");
    await settle(chat);
    expect(wrapper.find(".fdn-approval-state").text()).toBe("Allowed always");
  });

  it("offers only Allow and Deny for a tool that cannot be undone", async () => {
    const { wrapper, chat } = await panel(fillsThenAnswers, {}, "destructive");
    await wrapper.find("textarea").setValue("Send it");
    await button(wrapper, "Send").trigger("click");
    await waitUntil(() => wrapper.find(".fdn-approval").exists());
    const labels = wrapper.findAll(".fdn-approval-actions button").map((b) => b.text());
    expect(labels).toEqual(["Allow", "Deny"]);
    await button(wrapper, "Deny").trigger("click");
    await settle(chat);
  });

  it("lets the user pick a tool mode, closes the menu on a click outside, and resets approvals", async () => {
    const { wrapper, chat } = await panel(() => ({ text: "ok" }));
    await button(wrapper, /^Tool mode/).trigger("click");
    await wrapper.findAll("[role=menuitemradio]").find((b) => b.text().startsWith("Read only"))!.trigger("click");
    expect(chat.toolMode).toBe("read_only");
    await button(wrapper, /^Tool mode/).trigger("click");
    expect(chat.isModeMenuOpen).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(chat.isModeMenuOpen).toBe(false);
    await button(wrapper, /^Tool mode/).trigger("click");
    await wrapper.findAll("[role=menuitem]").find((b) => b.text() === "Reset approvals")!.trigger("click");
    expect(chat.isModeMenuOpen).toBe(false);
  });

  it("speaks the chat's language: German strings, lang and the composer", async () => {
    const { wrapper } = await panel(() => ({ text: "ok" }), { strings: stringsFor("de-AT") });
    expect(wrapper.attributes("lang")).toBe("de");
    expect(wrapper.find("textarea").attributes("placeholder")).toBe("Stellen Sie eine Frage");
    expect(button(wrapper, "Senden").exists()).toBe(true);
    expect(button(wrapper, /^Tool-Modus: Nachfragen/).exists()).toBe(true);
  });
});

describe("ChatPanel's slots and renderers (Vue)", () => {
  it("puts the host's content in the header, above and in the composer, and replaces the avatar", async () => {
    const { wrapper } = await panel(() => ({ text: "ok" }), {}, "write", {
      slots: {
        "header-extra": () => h("button", { class: "host-account" }, "Account"),
        "context-bar": () => h("div", { class: "host-context" }, "report.pdf"),
        "composer-accessory": () => h("button", { class: "host-summarise" }, "Summarise"),
        avatar: () => h("img", { class: "host-logo", alt: "" }),
      },
    });
    expect(wrapper.find(".fdn-header .host-account").exists()).toBe(true);
    expect(wrapper.find(".host-context + .fdn-composer").exists()).toBe(true);
    expect(wrapper.find(".fdn-composer-accessory .host-summarise").exists()).toBe(true);
    expect(wrapper.find(".fdn-empty-mark .host-logo").exists()).toBe(true);
    expect(wrapper.find(".fdn-agent-avatar").exists()).toBe(false);
  });

  it("shows the host's sign-in instead of the chat when the agent needs one", async () => {
    const { chat } = await chatWith(() => ({ text: "ok" }), {}, "write", false);
    expect(chat.signInRequired).toBe(true);
    const wrapper = mount(ChatPanel, { props: { chat }, slots: { "sign-in": () => h("form", { class: "host-sign-in" }) } });
    wrappers.push(wrapper);
    expect(wrapper.find(".fdn-body-center .host-sign-in").exists()).toBe(true);
    expect(wrapper.find(".fdn-composer").exists()).toBe(false);
  });

  it("asks a renderer again when its part changes, and a renderer can keep the built-in view", async () => {
    let asked = 0;
    const searchCard: PartRenderer = (part, strings) => {
      if (!(part instanceof ToolCallPart)) return undefined;
      asked++;
      if (part.state !== "succeeded") return undefined;
      return [h("section", { class: "host-results" }, "3 files"), h(ToolCallView, { part, strings })];
    };
    const { wrapper, chat } = await panel((r) => (lastToolResults(r).size ? { text: "Found them." } : { toolCalls: [{ name: "read_page" }] }),
      {}, "write", { props: { partRenderers: [searchCard] } });
    await wrapper.find("textarea").setValue("Find files");
    await button(wrapper, "Send").trigger("click");
    await settle(chat);
    expect(wrapper.find(".host-results + .fdn-tool").exists()).toBe(true);
    expect(wrapper.find(".fdn-tool-title").text()).toBe("Ran read_page");
    expect(asked).toBeGreaterThan(1);
  });

  it("runs the host's beforeSend from the composer: busy meanwhile, Stop aborts it, the text stays", async () => {
    let started = false;
    const { wrapper, chat, gateway } = await panel(() => ({ text: "ok" }), {
      beforeSend: (_message, signal) => new Promise<void>((_resolve, reject) => {
        started = true;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    });
    await wrapper.find("textarea").setValue("Summarise the file");
    await button(wrapper, "Send").trigger("click");
    await waitUntil(() => started);
    await flushPromises();
    await button(wrapper, "Stop").trigger("click");
    await settle(chat);
    expect(gateway.modelCalls).toHaveLength(0);
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("Summarise the file");
    expect(wrapper.find(".fdn-banner").exists()).toBe(false);
  });

  it("shows why beforeSend refused, and follows a new chat when the host swaps it", async () => {
    const { wrapper, chat } = await panel(() => ({ text: "ok" }), {
      beforeSend: () => {
        throw new Error("Select a file first.");
      },
    });
    await wrapper.find("textarea").setValue("Summarise");
    await button(wrapper, "Send").trigger("click");
    await settle(chat);
    expect(wrapper.find(".fdn-banner").text()).toBe("Select a file first.");

    const other = await chatWith(() => ({ text: "ok" }), { strings: stringsFor("fr") });
    await wrapper.setProps({ chat: other.chat });
    expect(wrapper.attributes("lang")).toBe("fr");
    other.chat.setInput("Bonjour");
    await nextTick();
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("Bonjour");
    chat.setInput("old chat"); // the panel no longer listens to the first chat
    await nextTick();
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("Bonjour");
  });
});

describe("ChatPanel in a host component", () => {
  it("works in a template: the chat in a prop, a class and a theme on the panel, a slot with the host's button", async () => {
    const { chat } = await chatWith(() => ({ text: "Hello from the agent." }));
    const wrapper = mount(HostPanel, { props: { chat } });
    wrappers.push(wrapper);
    expect(wrapper.find(".fdn-chat.host-panel[data-theme=dark] .host-out").exists()).toBe(true);
    chat.setInput("Hi");
    await chat.send();
    await flushPromises();
    expect(wrapper.text()).toContain("Hello from the agent.");
  });
});

describe("ChatPanel's settings (Vue)", () => {
  it("lets the user pick a language, and the whole panel speaks it; the host's items sit below", async () => {
    const { wrapper, chat } = await panel(() => ({ text: "ok" }), { automaticLanguage: "en-US" }, "write",
      { slots: { "settings-extra": () => h("button", { type: "button", class: "host-sign-out" }, "Sign out") } });
    await button(wrapper, "Settings").trigger("click");
    expect(wrapper.findAll("[role=menuitemradio]").map((b) => b.text())).toEqual(
      ["Automatic (English)", "English", "Deutsch", "Français", "Español", "中文（简体）"]);
    expect(wrapper.find(".fdn-settings .fdn-menu-extra .host-sign-out").exists()).toBe(true);
    await wrapper.findAll("[role=menuitemradio]").find((b) => b.text() === "Deutsch")!.trigger("click");
    await flushPromises();
    expect(chat.isSettingsOpen).toBe(false);
    expect(wrapper.find(".fdn-settings").exists()).toBe(false);
    expect(wrapper.find("textarea").attributes("placeholder")).toBe("Stellen Sie eine Frage");
    expect(button(wrapper, "Einstellungen").exists()).toBe(true);
    expect(wrapper.attributes("lang")).toBe("de");
  });

  it("shows the language the organisation fixed, without a choice, and the button with only About when there is nothing to set", async () => {
    const locked = await panel(() => ({ text: "ok" }), { lockedLanguage: "fr" });
    await button(locked.wrapper, "Paramètres").trigger("click");
    expect(locked.wrapper.find(".fdn-menu-note").text()).toBe("Défini par votre organisation");
    expect(locked.wrapper.findAll("[role=menuitemradio]").every((b) => (b.element as HTMLButtonElement).disabled)).toBe(true);
    expect(locked.wrapper.findAll(".fdn-settings [role=menuitem]").map((b) => b.text())).toEqual(["À propos"]);

    const fixed = await panel(() => ({ text: "ok" }), { strings: { send: "Go" } });
    await button(fixed.wrapper, "Settings").trigger("click");
    expect(fixed.wrapper.findAll("[role=menuitemradio]")).toHaveLength(0);
    expect(fixed.wrapper.findAll(".fdn-settings [role=menuitem]").map((b) => b.text())).toEqual(["About"]);
  });

  it("puts About after the host's items", async () => {
    const { wrapper } = await panel(() => ({ text: "ok" }), {}, "write",
      { slots: { "settings-extra": () => h("button", { type: "button", role: "menuitem" }, "Sign out") } });
    await button(wrapper, "Settings").trigger("click");
    expect(wrapper.findAll(".fdn-settings [role=menuitem]").map((b) => b.text())).toEqual(["Sign out", "About"]);
  });
});

const sdkMinor = majorMinor(SDK_VERSION)!;

describe("ChatPanel's About and links (Vue)", () => {
  it("has a muted Fadenstack link after the AI notice, which opens through openLink", async () => {
    const opened: string[] = [];
    const { wrapper } = await panel(() => ({ text: "ok" }), { openLink: (url) => opened.push(url), refSource: "nextcloud" });
    const link = wrapper.find(".fdn-ai-notice a");
    expect(link.attributes()).toMatchObject({
      href: `https://fadenstack.com/?ref=nextcloud-panel&v=${sdkMinor}`, target: "_blank", rel: "noopener noreferrer",
      "aria-label": "Fadenstack (opens in a new tab)",
    });
    expect(link.text()).toBe("Fadenstack");
    expect(wrapper.find(".fdn-ai-notice > span[dir=auto]").text()).toBe("Answers are generated by AI and can be wrong. Check what matters.");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual([`https://fadenstack.com/?ref=nextcloud-panel&v=${sdkMinor}`]);
  });

  it("drops only the footer link with branding false; with no notice either, the line goes", async () => {
    const { wrapper } = await panel(() => ({ text: "ok" }), { branding: false });
    expect(wrapper.find(".fdn-ai-notice a").exists()).toBe(false);
    expect(wrapper.find(".fdn-ai-notice-separator").exists()).toBe(false);
    await button(wrapper, "Settings").trigger("click");
    await wrapper.find(".fdn-settings [role=menuitem]").trigger("click");
    expect(wrapper.findAll(".fdn-about a")).toHaveLength(3);

    const alone = await panel(() => ({ text: "ok" }), { strings: { aiNotice: "" } });
    expect(alone.wrapper.find(".fdn-ai-notice").text()).toBe("Fadenstack");
    const none = await panel(() => ({ text: "ok" }), { strings: { aiNotice: "" }, branding: false });
    expect(none.wrapper.find(".fdn-ai-notice").exists()).toBe(false);
  });

  it("shows About over the panel: the agent, the SDK, the server and links; Escape closes it and the gear has the focus", async () => {
    const opened: string[] = [];
    const { wrapper, chat } = await panel(() => ({ text: "ok" }), { openLink: (url) => opened.push(url) });
    await button(wrapper, "Settings").trigger("click");
    await wrapper.find(".fdn-settings [role=menuitem]").trigger("click");
    await flushPromises();
    expect(chat.isSettingsOpen).toBe(false);
    expect(wrapper.find(".fdn-settings").exists()).toBe(false);
    const about = wrapper.find("[role=dialog]");
    expect(about.attributes("aria-label")).toBe("About");
    expect(document.activeElement).toBe(button(wrapper, "Close").element);
    expect(about.find(".fdn-about-name").text()).toBe("Page assistant");
    expect(about.findAll(".fdn-about-line").map((l) => l.text())).toEqual([
      "Version 1", "Model: fake-model", `Fadenstack SDK ${SDK_VERSION} (TypeScript)`, "Server: https://faden.test",
    ]);
    const links = about.findAll("a");
    expect(links.map((a) => [a.attributes("aria-label"), a.attributes("href"), a.attributes("target"), a.attributes("rel")])).toEqual([
      ["Help (opens in a new tab)", "https://faden.test/help/", "_blank", "noopener noreferrer"],
      ["Fadenstack (opens in a new tab)", `https://fadenstack.com/?ref=sdk-about&v=${sdkMinor}`, "_blank", "noopener noreferrer"],
      ["Developer docs (opens in a new tab)", `https://developers.fadenstack.com/?ref=sdk-about&v=${sdkMinor}`, "_blank", "noopener noreferrer"],
    ]);
    await links[0]!.trigger("click");
    expect(opened).toEqual(["https://faden.test/help/"]);
    await button(wrapper, "Close").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, "Settings").element);
  });

  it("closes About with its button and with a press outside; copies the details", async () => {
    const { wrapper, chat, clipboard } = await panel(() => ({ text: "ok" }));
    chat.setAboutOpen(true);
    await flushPromises();
    await button(wrapper, "Copy details").trigger("click");
    await flushPromises();
    expect(clipboard.lastText).toBe(["Page assistant", "Version 1", "Model: fake-model", `Fadenstack SDK ${SDK_VERSION} (TypeScript)`,
      "Server: https://faden.test"].join("\n"));
    expect(wrapper.find(".fdn-about .fdn-button").text()).toBe("Copied");
    await button(wrapper, "Close").trigger("click");
    expect(chat.isAboutOpen).toBe(false);
    chat.setAboutOpen(true);
    await flushPromises();
    document.querySelector("textarea")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
  });
});
