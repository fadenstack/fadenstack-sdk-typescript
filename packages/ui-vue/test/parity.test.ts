// @vitest-environment jsdom
// The Vue skin draws the same markup as the React skin, so one stylesheet (@fadenstack/ui-web) fits both: each
// state of a chat is rendered by both panels, from the same view model, and compared element by element.
import { act, cleanup, render } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalPart, AttachmentViewModel, ToolCallPart, germanStrings, withStrings, type AgentChatViewModel } from "@fadenstack/ui";
import { AgentAvatar as ReactAvatar, ChatPanel as ReactPanel } from "@fadenstack/ui-react";
import { AgentAvatar as VueAvatar, ChatPanel as VuePanel } from "@fadenstack/ui-vue";

import { chatWith, normalize, readFillAnswer, waitUntil } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  cleanup();
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

/** Both panels on the same chat, kept up to date; `same()` compares them now. */
function both(chat: AgentChatViewModel) {
  const react = render(createElement(ReactPanel, { chat }));
  const vue = mount(VuePanel, { props: { chat }, attachTo: document.body });
  wrappers.push(vue);
  return {
    async same(): Promise<void> {
      await act(async () => {});
      await flushPromises();
      expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));
    },
  };
}

describe("the Vue panel draws what the React panel draws", () => {
  it("for an empty chat: the agent, its greeting and suggestions", async () => {
    const { chat } = await chatWith(() => ({ text: "ok" }));
    await both(chat).same();
  });

  it("through a turn: tool lines, an approval card, reasoning, references and every kind of Markdown", async () => {
    const { chat } = await chatWith(readFillAnswer);
    const panels = both(chat);
    const sending = chat.send("Fill my name");
    await waitUntil(() => chat.turns[0]?.parts.some((p) => p instanceof ApprovalPart) ?? false);
    await panels.same();
    (chat.turns[0]!.parts.find((p) => p instanceof ApprovalPart) as ApprovalPart).allow();
    await sending;
    await panels.same();
    for (const part of chat.turns[0]!.parts) if ("toggle" in part && typeof part.toggle === "function") (part.toggle as () => void)();
    await panels.same();
  });

  it("for chips in the composer, implicit and removable", async () => {
    const { chat } = await chatWith(() => ({ text: "ok" }));
    const panels = both(chat);
    const page = new AttachmentViewModel({ title: "example.com", subtitle: "page", implicit: true, resolve: () => Promise.resolve(undefined) });
    chat.addAttachment(page);
    chat.attach({ title: "Selection", content: "Hello", kind: "selection" });
    chat.setInput("Explain");
    await panels.same();
    page.toggle();
    await panels.same();
  });

  it("for the skill picker, a picked skill and a picture, in the composer and in the sent message", async () => {
    const skills = [
      { slug: "reply", name: "Reply in our style", description: "Answers a mail the way we write" },
      { slug: "check", name: "Contract check" },
    ];
    const { chat } = await chatWith(() => ({ text: "ok" }), {}, "write", true, { skills, vision: true });
    const panels = both(chat);
    chat.setInput("Answer $");
    await waitUntil(() => chat.skillPicker.options.length === 2);
    await panels.same();
    chat.skillPicker.move(1);
    chat.setInput("Answer $nothing-like-it");
    await panels.same();
    chat.setInput("Answer $rep");
    chat.skillPicker.pick();
    chat.attachPicture({ dataUrl: "data:image/jpeg;base64,/9j/", title: "Screenshot" });
    await panels.same();
    await chat.send();
    await panels.same();
  });

  it("for a refused message, a failed tool and history", async () => {
    let refuse = true;
    const { chat } = await chatWith(() => (refuse ? { refuse: { stage: "input", message: "Customer data stays here." } }
      : { toolCalls: [{ name: "missing_tool" }], text: "Tried." }));
    const panels = both(chat);
    await chat.send("Our customer list");
    await panels.same();
    refuse = false;
    await chat.send("Try a tool");
    await chat.toggleHistory();
    await panels.same();
    expect(chat.turns[1]!.parts.some((p) => p instanceof ToolCallPart)).toBe(true);
  });

  it("in German, and right to left", async () => {
    const { chat } = await chatWith(() => ({ text: "Hallo **Welt**" }), { strings: germanStrings, locale: "de-DE" });
    const panels = both(chat);
    await chat.send("Hallo");
    await panels.same();
    expect(document.querySelector(".fdn-chat")!.getAttribute("lang")).toBe("de");

    const rtl = await chatWith(() => ({ text: "שלום" }), { strings: withStrings({ language: "he", direction: "rtl", send: "שלח" }) });
    const rtlPanels = both(rtl.chat);
    await rtl.chat.send("שלום");
    await rtlPanels.same();
  });
});

describe("the settings draw the same in both panels", () => {
  it("with a choice of languages, and with the language the organisation fixed", async () => {
    const { chat } = await chatWith(() => ({ text: "ok" }), { automaticLanguage: "de-DE" });
    const panels = both(chat);
    chat.setSettingsOpen(true);
    await panels.same();
    await chat.setLanguage("zh-Hans");
    chat.setSettingsOpen(true);
    await panels.same();

    const locked = await chatWith(() => ({ text: "ok" }), { lockedLanguage: "es" });
    const lockedPanels = both(locked.chat);
    locked.chat.setSettingsOpen(true);
    await lockedPanels.same();
  });
});

describe("About and the Fadenstack link draw the same in both panels", () => {
  it("with About open, the footer link, a host's refSource, and without branding", async () => {
    const { chat } = await chatWith(() => ({ text: "ok" }), { refSource: "office" });
    const panels = both(chat);
    await panels.same();
    chat.setAboutOpen(true);
    await panels.same();
    expect(document.querySelectorAll(".fdn-about a[href*='ref=office-about']")).toHaveLength(4);

    const plain = await chatWith(() => ({ text: "ok" }), { branding: false, strings: germanStrings });
    const plainPanels = both(plain.chat);
    plain.chat.setSettingsOpen(true);
    await plainPanels.same();
    plain.chat.setAboutOpen(true);
    await plainPanels.same();

    const alone = await chatWith(() => ({ text: "ok" }), { strings: { aiNotice: "" } });
    await both(alone.chat).same();
  });
});

describe("the Vue avatar draws what the React avatar draws", () => {
  it.each([
    [{}], [{ size: 24 }], [{ variant: "mono" as const }], [{ variant: "mono" as const, size: 24 }], [{ color: "#0E9F9A" }],
    [{ label: "Page assistant" }],
  ])("%o", (props) => {
    const react = render(createElement(ReactAvatar, props));
    const vue = mount(VueAvatar, { props });
    wrappers.push(vue);
    expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));
  });
});
