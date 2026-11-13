// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryPromptStore, type AgentChatOptions } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-vue";
import type { FakeAgent } from "@fadenstack/testing";

import { chatWith, waitUntil } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

const SKILLS = [{ slug: "reply", name: "Reply in our style", description: "Answers a customer mail" }];

async function withPrompts(options: Partial<AgentChatOptions> = {}, agent: Partial<FakeAgent> = {}) {
  const prompts = new MemoryPromptStore();
  await prompts.save("Summarise this page in five points");
  await prompts.save("Antworte freundlich auf diese Mail");
  const made = await chatWith(() => ({ text: "An answer." }), { prompts, ...options }, "write", true, agent);
  const wrapper = mount(ChatPanel, { props: { chat: made.chat }, attachTo: document.body });
  wrappers.push(wrapper);
  return { ...made, prompts, wrapper };
}

async function type(wrapper: VueWrapper, text: string) {
  await wrapper.find("textarea").setValue(text);
}

describe("the prompt picker (Vue)", () => {
  it("shows My prompts, then the organisation's skills, in one listbox with presentational headings", async () => {
    const { wrapper } = await withPrompts({}, { skills: SKILLS });
    await type(wrapper, "$");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 3);
    const list = wrapper.find("[role=listbox]");
    expect(list.attributes("aria-label")).toBe("Prompts and skills");
    expect(list.findAll(".fdn-menu-heading").map((h) => [h.text(), h.attributes("role")])).toEqual([["My prompts", "presentation"], ["Your organisation's skills", "presentation"]]);
    expect(wrapper.findAll("[role=option]").map((o) => o.find(".fdn-menu-label").text())).toEqual([
      "Antworte freundlich auf diese Mail", "Summarise this page in five points", "Reply in our style",
    ]);
    expect(wrapper.find("textarea").attributes("aria-activedescendant")).toBe(wrapper.findAll("[role=option]")[0]!.attributes("id"));
    expect(wrapper.findAll("[role=option]")[0]!.attributes("aria-selected")).toBe("true");
  });

  it("moves across both sections with the arrows and picks a prompt with Enter, which replaces the $ token", async () => {
    const { wrapper, chat } = await withPrompts({}, { skills: SKILLS });
    await type(wrapper, "Hello $");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 3);
    const box = wrapper.find("textarea");
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.findAll("[role=option]")[2]!.attributes("aria-selected")).toBe("true");
    await box.trigger("keydown", { key: "ArrowUp" });
    await box.trigger("keydown", { key: "Enter" });
    expect(chat.input).toBe("Hello Summarise this page in five points");
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("Hello Summarise this page in five points");
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    expect(chat.pickedSkills).toEqual([]);
  });

  it("closes with Escape, and a press on a prompt picks it", async () => {
    const { wrapper, chat } = await withPrompts();
    await type(wrapper, "$");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 2);
    await wrapper.find("textarea").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    await type(wrapper, "");
    await type(wrapper, "$");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 2);
    await wrapper.findAll("[role=option]")[1]!.trigger("mousedown");
    expect(chat.input).toBe("Summarise this page in five points");
  });

  it("opens with only prompts when the server offers no skills, and says how to save one while there are none", async () => {
    const made = await chatWith(() => ({ text: "ok" }), { prompts: new MemoryPromptStore() });
    const wrapper = mount(ChatPanel, { props: { chat: made.chat }, attachTo: document.body });
    wrappers.push(wrapper);
    await type(wrapper, "$");
    await waitUntil(() => wrapper.text().includes("No saved prompts yet"));
    expect(wrapper.text()).not.toContain("Your organisation's skills");
    expect(wrapper.find("[role=listbox]").attributes("aria-label")).toBe("My prompts");
  });

  it("deletes a prompt with its small button, without picking it", async () => {
    const { wrapper, chat, prompts } = await withPrompts();
    await type(wrapper, "$");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 2);
    const del = wrapper.findAll("button").find((b) => b.attributes("aria-label") === "Delete prompt: Summarise this page in five points")!;
    expect(del.attributes("title")).toBe("Delete prompt");
    await del.trigger("click");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 1);
    expect((await prompts.list()).length).toBe(1);
    expect(chat.input).toBe("$");
  });

  it("speaks German", async () => {
    const { wrapper } = await withPrompts({ automaticLanguage: "de" });
    await type(wrapper, "$");
    await waitUntil(() => wrapper.findAll("[role=option]").length === 2);
    expect(wrapper.text()).toContain("Meine Prompts");
    expect(wrapper.findAll("button").filter((b) => (b.attributes("aria-label") ?? "").startsWith("Prompt löschen:")).length).toBe(2);
  });
});

describe("Save as prompt (Vue)", () => {
  it("sits among a sent message's actions, saves it, and says so for a moment", async () => {
    const { wrapper, chat, prompts } = await withPrompts();
    await chat.send("Please check the Q3 numbers");
    await flushPromises();
    const save = wrapper.findAll("button").find((b) => b.attributes("aria-label") === "Save as prompt")!;
    expect(save.classes()).toEqual(["fdn-icon-button", "fdn-small"]);
    await save.trigger("click");
    await waitUntil(() => wrapper.find("[role=status]").exists());
    expect(wrapper.find(".fdn-turn-actions [role=status]").text()).toBe("Saved as a prompt");
    expect((await prompts.list())[0]!.text).toBe("Please check the Q3 numbers");
    expect(save.attributes("title")).toBe("Saved as a prompt");
  });

  it("tells why when a prompt is refused", async () => {
    const { wrapper, chat } = await withPrompts();
    await chat.send("x".repeat(4001));
    await flushPromises();
    await wrapper.findAll("button").find((b) => b.attributes("aria-label") === "Save as prompt")!.trigger("click");
    await waitUntil(() => wrapper.find(".fdn-turn-actions [role=status]").exists());
    expect(wrapper.find(".fdn-turn-actions [role=status]").text()).toBe("A prompt can have at most 4,000 characters.");
  });

  it("is absent without a prompt store, and has a German label with one", async () => {
    const plain = await chatWith(() => ({ text: "ok" }));
    const w1 = mount(ChatPanel, { props: { chat: plain.chat }, attachTo: document.body });
    wrappers.push(w1);
    await plain.chat.send("Hello");
    await flushPromises();
    expect(w1.findAll("button").some((b) => b.attributes("aria-label") === "Save as prompt")).toBe(false);

    const { wrapper, chat } = await withPrompts({ automaticLanguage: "de" });
    await chat.send("Hallo");
    await flushPromises();
    expect(wrapper.findAll("button").some((b) => b.attributes("aria-label") === "Als Prompt speichern")).toBe(true);
  });
});
