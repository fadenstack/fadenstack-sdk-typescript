// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryPromptStore, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway, type FakeAgent } from "@fadenstack/testing";
import { testServices } from "./services.js";

afterEach(cleanup);

async function panel(options: Partial<AgentChatOptions> = {}, agent: Partial<FakeAgent> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ...agent }], model: () => ({ text: "An answer." }) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const chat = new AgentChatViewModel(built, approvals, {
    ...testServices(), scheduler: immediateScheduler, locale: "en-GB", ...options,
  });
  await act(() => chat.initialize());
  render(<ChatPanel chat={chat} />);
  return { chat };
}

const SKILLS = [{ slug: "reply", name: "Reply in our style", description: "Answers a customer mail" }];

async function withPrompts(options: Partial<AgentChatOptions> = {}, agent: Partial<FakeAgent> = {}) {
  const prompts = new MemoryPromptStore();
  await prompts.save("Summarise this page in five points");
  await prompts.save("Antworte freundlich auf diese Mail");
  const made = await panel({ prompts, ...options }, agent);
  return { ...made, prompts };
}

function type(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

describe("the prompt picker (React)", () => {
  it("shows My prompts, then the organisation's skills, in one listbox with presentational headings", async () => {
    await withPrompts({}, { skills: SKILLS });
    type("$");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("aria-label")).toBe("Prompts and skills");
    const headings = [...list.querySelectorAll(".fdn-menu-heading")];
    expect(headings.map((h) => [h.textContent, h.getAttribute("role")])).toEqual([["My prompts", "presentation"], ["Your organisation's skills", "presentation"]]);
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".fdn-menu-label")!.textContent)).toEqual([
      "Antworte freundlich auf diese Mail", "Summarise this page in five points", "Reply in our style",
    ]);
    expect(screen.getByRole("textbox").getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("option")[0]!.querySelector("[dir=auto]")).toBeTruthy();
  });

  it("moves across both sections with the arrows and picks a prompt with Enter, which replaces the $ token", async () => {
    const { chat } = await withPrompts({}, { skills: SKILLS });
    type("Hello $");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    const box = screen.getByRole("textbox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]!.getAttribute("aria-selected")).toBe("true"); // the skill, in the second section
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(chat.input).toBe("Hello Summarise this page in five points");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hello Summarise this page in five points");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chat.pickedSkills).toEqual([]);
  });

  it("closes with Escape, and a press on a prompt picks it", async () => {
    const { chat } = await withPrompts();
    type("$");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type("");
    type("$");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));
    fireEvent.mouseDown(screen.getAllByRole("option")[1]!);
    expect(chat.input).toBe("Summarise this page in five points");
  });

  it("opens with only prompts when the server offers no skills, and says how to save one while there are none", async () => {
    await panel({ prompts: new MemoryPromptStore() });
    type("$");
    await waitFor(() => expect(screen.getByText(/No saved prompts yet/)).toBeTruthy());
    expect(screen.queryByText("Your organisation's skills")).toBeNull();
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("My prompts");
  });

  it("deletes a prompt with its small button, without picking it", async () => {
    const { chat, prompts } = await withPrompts();
    type("$");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));
    const del = screen.getByRole("button", { name: "Delete prompt: Summarise this page in five points" });
    expect(del.getAttribute("title")).toBe("Delete prompt");
    await act(async () => {
      fireEvent.click(del);
    });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    expect((await prompts.list()).length).toBe(1);
    expect(chat.input).toBe("$");
  });

  it("speaks German", async () => {
    await withPrompts({ automaticLanguage: "de" });
    type("$");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));
    expect(screen.getByText("Meine Prompts")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Prompt löschen:/ }).length).toBe(2);
  });
});

describe("Save as prompt (React)", () => {
  it("sits among a sent message's actions, saves it, and says so for a moment", async () => {
    const { chat, prompts } = await withPrompts();
    await act(() => chat.send("Please check the Q3 numbers"));
    const save = screen.getByRole("button", { name: "Save as prompt" });
    expect(save.className).toBe("fdn-icon-button fdn-small");
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved as a prompt"));
    expect((await prompts.list())[0]!.text).toBe("Please check the Q3 numbers");
    expect(save.getAttribute("title")).toBe("Saved as a prompt");
  });

  it("tells why when a prompt is refused", async () => {
    const { chat } = await withPrompts();
    await act(() => chat.send("x".repeat(4001)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as prompt" }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("A prompt can have at most 4,000 characters."));
  });

  it("is absent without a prompt store", async () => {
    const { chat } = await panel();
    await act(() => chat.send("Hello"));
    expect(screen.queryByRole("button", { name: "Save as prompt" })).toBeNull();
  });

  it("has a German label", async () => {
    const { chat } = await withPrompts({ automaticLanguage: "de" });
    await act(() => chat.send("Hallo"));
    expect(screen.getByRole("button", { name: "Als Prompt speichern" })).toBeTruthy();
  });
});
