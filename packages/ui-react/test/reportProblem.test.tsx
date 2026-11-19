// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MachinePolicy, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway, type FakeModel } from "@fadenstack/testing";
import { testServices } from "./services.js";

afterEach(cleanup);

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
  await act(() => chat.initialize());
  render(<ChatPanel chat={chat} />);
  return { chat, clipboard, opened };
}

const openFromAbout = () => {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "About" }));
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
};

describe("Report a problem (React)", () => {
  it("is a button beside Copy details in About, and opens a dialog in its place that takes the focus", async () => {
    await panel({}, "it-help@corp.example");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "About" }));
    const about = screen.getByRole("dialog", { name: "About" });
    const row = about.querySelector(".fdn-report-actions")!;
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Copy details", "Report a problem"]);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.queryByRole("dialog", { name: "About" })).toBeNull();
    const sheet = screen.getByRole("dialog", { name: "Report a problem" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(sheet.textContent).toContain("This goes to it-help@corp.example.");
    expect(sheet.textContent).toContain("This report contains:");
    expect(sheet.textContent).toContain("Nothing from your chats is included.");
    const preview = screen.getByRole("textbox", { name: "This report contains:" }) as HTMLTextAreaElement;
    expect(preview.readOnly).toBe(true);
    expect(preview.value.startsWith("What happened:\n\n\n-- \nApp: Word add-in 1.2.0\n")).toBe(true);
    expect([...sheet.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Close", "Write mail", "Copy details"]);
  });

  it("writes the mail through the host's openLink and copies the details with Copied", async () => {
    const { chat, clipboard, opened } = await panel({}, "it-help@corp.example");
    openFromAbout();
    fireEvent.click(screen.getByRole("button", { name: "Write mail" }));
    expect(opened).toEqual([chat.reportProblem.mailto]);
    expect(opened[0]!.startsWith("mailto:it-help@corp.example?subject=Problem%20with%20Word%20add-in%201.2.0")).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    });
    expect(clipboard.lastText!.startsWith("To: it-help@corp.example\nSubject: Problem with Word add-in 1.2.0 (Fadenstack SDK ")).toBe(true);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("closes with Escape and with Close, giving the focus back to the gear About was opened from", async () => {
    const { chat } = await panel({}, "it-help@corp.example");
    openFromAbout();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chat.isReportProblemOpen).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
    openFromAbout();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
  });

  it("closes with a press outside it", async () => {
    const { chat } = await panel({}, "it-help@corp.example");
    openFromAbout();
    fireEvent.pointerDown(screen.getByRole("textbox", { name: chat.strings.composerPlaceholder }));
    expect(chat.isReportProblemOpen).toBe(false);
  });

  it("governed without the key: no Write mail, the organisation's IT to ask, its Help link, and the copy without a To line", async () => {
    const { clipboard } = await panel();
    openFromAbout();
    const sheet = screen.getByRole("dialog", { name: "Report a problem" });
    expect(screen.queryByRole("button", { name: "Write mail" })).toBeNull();
    expect(sheet.textContent).toContain("Ask your organisation's IT for help. You can copy the details below for them.");
    expect(sheet.querySelector("a")!.getAttribute("href")).toBe("https://faden.test/help/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    });
    expect(clipboard.lastText!.startsWith("Subject: Problem with Word add-in 1.2.0 (Fadenstack SDK ")).toBe(true);
    expect(clipboard.lastText).not.toContain("To:");
  });

  it("is on a failed turn's error, adds its code, and gives the focus back to the link", async () => {
    const { chat } = await panel({}, "it-help@corp.example", () => ({ badRequest: { code: "picture_type_not_allowed", message: "raw server text" } }));
    await act(() => chat.send("My secret question"));
    const link = screen.getByRole("button", { name: "Report a problem" });
    expect(link.closest(".fdn-status")!.textContent).toContain("Something went wrong");
    link.focus();
    fireEvent.click(link);
    const sheet = screen.getByRole("dialog", { name: "Report a problem" });
    const preview = screen.getByRole("textbox", { name: "This report contains:" }) as HTMLTextAreaElement;
    expect(preview.value.split("\n").at(-1)).toBe("Error: picture_type_not_allowed");
    expect(sheet.textContent).not.toContain("My secret question");
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Report a problem" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Report a problem" }));
  });

  it("has no link on a turn that went well", async () => {
    const { chat } = await panel();
    await act(() => chat.send("Hi"));
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });

  it("speaks German: the button, the sheet and the mail's lines", async () => {
    await panel({ lockedLanguage: "de" }, "it@firma.example");
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Info" }));
    fireEvent.click(screen.getByRole("button", { name: "Problem melden" }));
    const sheet = screen.getByRole("dialog", { name: "Problem melden" });
    expect(sheet.textContent).toContain("Das geht an it@firma.example.");
    expect(sheet.textContent).toContain("Nichts aus Ihren Chats ist enthalten.");
    expect([...sheet.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Schließen", "E-Mail schreiben", "Details kopieren"]);
    expect((screen.getByRole("textbox", { name: "Dieser Bericht enthält:" }) as HTMLTextAreaElement).value.startsWith("Was ist passiert:\n")).toBe(true);
  });
});
