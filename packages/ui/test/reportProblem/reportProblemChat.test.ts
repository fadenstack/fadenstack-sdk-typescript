import { describe, expect, it } from "vitest";

import { EndpointDialect, FadenstackClient, SDK_VERSION, loginWithPassword } from "@fadenstack/client";
import {
  AgentDefinition, FadenstackAgent, MachinePolicy, MemoryApprovalStore, MemorySessionStore, defineTool, type AgentBuilder,
} from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler, type AgentChatOptions,
} from "@fadenstack/ui";
import { FakeGateway, OpenAiFake, lastToolResults, type FakeAgent, type FakeModel } from "@fadenstack/testing";

import { testServices } from "../services.js";

// "Report a problem" on a chat view model: to whom it goes in each mode, what the sheet and the copy say, and what they never say.

const SECRET_PROMPT = "my password is hunter2-prompt";
const SECRET_ARGUMENT = "sk-live-9f8e7d6c5b4a-argument";
const SECRET_RESULT = "secret-result-from-the-tool";
const SECRET_ANSWER = "the-answer-names-Mrs-Mueller";
const SECRET_REASONING = "private-reasoning-about-payroll";
const SECRET_FILE = "Payroll-2026.xlsx";

interface Setup {
  policy?: MachinePolicy;
  options?: Partial<AgentChatOptions>;
  model?: FakeModel;
  agent?: Partial<FakeAgent>;
  app?: { name: string; version?: string };
  browserLog?: boolean;
  configure?: (builder: AgentBuilder) => void;
}

async function governed(setup: Setup = {}) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", name: "Page assistant", contract: [{ name: "lookup", risk: "read" }], ...setup.agent }],
    ...(setup.model ? { model: setup.model } : {}),
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool<{ query: string }>({
      name: "lookup", toolClass: "read", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: () => SECRET_RESULT,
    }));
  if (setup.policy) builder.useMachinePolicy(setup.policy);
  if (setup.app) builder.describeApp(setup.app);
  if (setup.browserLog) builder.useBrowserLog({ factory: undefined });
  setup.configure?.(builder);
  const clipboard = new MemoryClipboard();
  const opened: string[] = [];
  const chat = new AgentChatViewModel(builder.build(), approvals, {
    ...testServices(), scheduler: immediateScheduler, clipboard, openLink: (url) => opened.push(url), automaticLanguage: "en", ...setup.options,
  });
  await chat.initialize();
  return { chat, clipboard, opened, gateway, builder };
}

async function standalone(setup: Setup & { baseUrl?: string; dialect?: EndpointDialect } = {}) {
  const fake = new OpenAiFake();
  const builder = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: setup.baseUrl ?? "http://localhost:11434/v1", model: "qwen3-32b", dialect: setup.dialect ?? EndpointDialect.ollama, fetch: fake.fetch, allowPlainHttpInLan: true })
    .useLocalProfile(AgentDefinition.fromJson('{"slug":"local","name":"Local assistant","version":{"instructions":"Hi.","host_tool_contract":[],"ui":{}}}'))
    .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore());
  if (setup.policy) builder.useMachinePolicy(setup.policy);
  if (setup.app) builder.describeApp(setup.app);
  if (setup.browserLog) builder.useBrowserLog({ factory: undefined });
  const approvals = new ApprovalBroker();
  const clipboard = new MemoryClipboard();
  const opened: string[] = [];
  const chat = new AgentChatViewModel(builder.build(), approvals, {
    ...testServices(), scheduler: immediateScheduler, clipboard, openLink: (url) => opened.push(url), automaticLanguage: "en", ...setup.options,
  });
  await chat.initialize();
  return { chat, clipboard, opened, builder };
}

const lines = (text: string) => text.split(/\r?\n/);
const decoded = (mailto: string) => decodeURIComponent(mailto);

describe("the sheet's state", () => {
  it("opens from About and from the failed turn, closing the settings, About and Tools; Close closes it", async () => {
    const { chat } = await governed();
    chat.setSettingsOpen(true);
    chat.setAboutOpen(true);
    chat.openReportProblem();
    expect([chat.isReportProblemOpen, chat.isAboutOpen, chat.isSettingsOpen, chat.isToolsOpen]).toEqual([true, false, false, false]);
    chat.setSettingsOpen(true);
    expect(chat.isReportProblemOpen).toBe(false); // the settings, About and Tools replace it as they replace one another
    chat.openReportProblem();
    chat.setAboutOpen(true);
    expect(chat.isReportProblemOpen).toBe(false);
    chat.openReportProblem();
    chat.setToolsOpen(true);
    expect(chat.isReportProblemOpen).toBe(false);
    chat.openReportProblem();
    chat.closeReportProblem();
    expect(chat.isReportProblemOpen).toBe(false);
  });

  it("forgets the error a turn opened it for when it closes", async () => {
    const { chat } = await governed();
    chat.openReportProblem({ code: "agent_disabled", requestId: "req-1" });
    expect(chat.reportProblem.preview).toContain("Error: agent_disabled (req-1)");
    chat.closeReportProblem();
    chat.openReportProblem();
    expect(chat.reportProblem.preview).not.toContain("Error:");
  });
});

describe("governed", () => {
  it("with the policy's key: the mail goes to it, with the server, the mode and the agent", async () => {
    const { chat, opened, gateway } = await governed({ policy: MachinePolicy.from({ supportEmail: "it-help@corp.example" }), app: { name: "Word add-in", version: "1.2.0" } });
    const view = chat.reportProblem;
    expect(view.address).toBe("it-help@corp.example");
    expect(view.goesTo).toBe("This goes to it-help@corp.example.");
    expect(view.canWriteMail).toBe(true);
    expect(view.help).toBeUndefined();
    expect(view.title).toBe("Report a problem");
    expect(view.contains).toBe("This report contains:");
    expect(view.noChats).toBe("Nothing from your chats is included.");
    const preview = lines(view.preview);
    expect(preview.slice(0, 5)).toEqual(["What happened:", "", "", "-- ", "App: Word add-in 1.2.0"]);
    expect(preview).toContain(`SDK: Fadenstack SDK ${SDK_VERSION} (TypeScript)`);
    expect(preview).toContain("Mode: Organisation");
    expect(preview).toContain("Agent: Page assistant, Version 1, Model: fake-model");
    expect(preview).toContain(`Server: ${gateway.serverUrl}`);
    expect(preview.some((l) => l.startsWith("System: "))).toBe(true);
    expect(preview.some((l) => /^Time: \d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(l))).toBe(true);
    expect(preview.some((l) => l.startsWith("Endpoint:"))).toBe(false);
    expect(view.mailto!.startsWith("mailto:it-help@corp.example?subject=Problem%20with%20Word%20add-in%201.2.0%20%28Fadenstack%20SDK%20")).toBe(true);
    expect(chat.writeReportMail()).toBe(true);
    expect(opened).toEqual([view.mailto]);
  });

  it("never uses the host's address or ours, even when the host gave one", async () => {
    const { chat } = await governed({ options: { supportEmail: "host@app.example" } });
    expect(chat.reportProblem.address).toBeUndefined();
    expect(chat.reportProblem.mailto).toBeUndefined();
    const { chat: other } = await governed({ options: { supportEmail: "host@app.example" }, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    expect(other.reportProblem.address).toBe("it@corp.example");
  });

  it("without the key: no mail, the organisation's IT to ask, its Help link, and the copy without a To line", async () => {
    const { chat, clipboard, opened, gateway } = await governed({ app: { name: "Word add-in", version: "1.2.0" } });
    const view = chat.reportProblem;
    expect(view.address).toBeUndefined();
    expect(view.canWriteMail).toBe(false);
    expect(view.mailto).toBeUndefined();
    expect(view.goesTo).toBe("Ask your organisation's IT for help. You can copy the details below for them.");
    expect(view.help).toEqual({ label: "Help", href: `${gateway.serverUrl}/help/` });
    expect(chat.writeReportMail()).toBe(false);
    expect(opened).toEqual([]);
    expect(await chat.copyReportDetails()).toBe(true);
    expect(clipboard.lastText!.startsWith(`Subject: Problem with Word add-in 1.2.0 (Fadenstack SDK ${SDK_VERSION})\n\nWhat happened:\n\n\n-- \nApp: Word add-in 1.2.0\n`)).toBe(true);
    expect(clipboard.lastText).not.toContain("To:");
    expect(clipboard.lastText).not.toContain("fadenstack.com");
    expect(clipboard.lastText).not.toContain("mailto");
  });

  it("with a policy value that is no plain address: as without the key", async () => {
    const { chat } = await governed({ policy: MachinePolicy.from({ supportEmail: "a@b.example?bcc=x@y.example" }) });
    expect(chat.reportProblem.address).toBeUndefined();
    expect(chat.reportProblem.canWriteMail).toBe(false);
  });

  it("names the app only when the host described it", async () => {
    const { chat } = await governed({ policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    expect(decoded(chat.reportProblem.mailto!)).toContain(`subject=Problem with Fadenstack SDK ${SDK_VERSION}&`);
    expect(chat.reportProblem.preview).not.toContain("App:");
  });

  it("adds a failed turn's code and request id, and only its code where there is no request id", async () => {
    const { chat } = await governed({ policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    chat.openReportProblem({ code: "picture_type_not_allowed", requestId: "req-8f3a21" });
    expect(lines(chat.reportProblem.preview).at(-1)).toBe("Error: picture_type_not_allowed (req-8f3a21)");
    chat.openReportProblem({ code: "agent_disabled" });
    expect(lines(chat.reportProblem.preview).at(-1)).toBe("Error: agent_disabled");
  });

  it("speaks the panel's language: German binding", async () => {
    const { chat } = await governed({ policy: MachinePolicy.from({ supportEmail: "it@firma.example" }), options: { lockedLanguage: "de" }, app: { name: "Word-Add-in", version: "1.2.0" } });
    const view = chat.reportProblem;
    expect(view.title).toBe("Problem melden");
    expect(view.goesTo).toBe("Das geht an it@firma.example.");
    expect(view.writeMail).toBe("E-Mail schreiben");
    expect(view.copyDetails).toBe("Details kopieren");
    expect(view.close).toBe("Schließen");
    const preview = lines(view.preview);
    expect(preview[0]).toBe("Was ist passiert:");
    expect(preview).toContain("Modus: Organisation");
    expect(preview).toContain("Agent: Page assistant, Version 1, Modell: fake-model");
    expect(decoded(view.mailto!)).toContain("subject=Problem mit Word-Add-in 1.2.0 (Fadenstack SDK");
  });
});

describe("standalone", () => {
  it("goes to the host's own address, and to ours when the host gave none", async () => {
    const hosted = await standalone({ options: { supportEmail: "support@my-app.example" } });
    expect(hosted.chat.reportProblem.address).toBe("support@my-app.example");
    expect(hosted.chat.reportProblem.goesTo).toBe("This goes to support@my-app.example.");
    const own = await standalone();
    expect(own.chat.reportProblem.address).toBe("support@fadenstack.com");
    expect(own.chat.reportProblem.canWriteMail).toBe(true);
    expect(own.chat.reportProblem.help).toBeUndefined();
  });

  it("goes to the policy's address before the host's", async () => {
    const { chat } = await standalone({ options: { supportEmail: "support@my-app.example" }, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    expect(chat.reportProblem.address).toBe("it@corp.example");
  });

  it("says the mode and the endpoint's dialect and place, never its address", async () => {
    const local = await standalone({ app: { name: "Chrome extension", version: "1.3.0" } });
    const preview = lines(local.chat.reportProblem.preview);
    expect(preview).toContain("Mode: Own AI");
    expect(preview).toContain("Endpoint: ollama, on this computer");
    expect(preview).toContain("Agent: Local assistant, Model: qwen3-32b");
    expect(preview.some((l) => l.startsWith("Server:"))).toBe(false);
    for (const [baseUrl, where] of [["http://192.168.1.20:8000/v1", "in the local network"], ["https://api.provider.example/v1", "on the internet"]] as const) {
      const other = await standalone({ baseUrl, dialect: EndpointDialect.vllm });
      const view = other.chat.reportProblem;
      expect(view.preview).toContain(`Endpoint: vllm, ${where}`);
      const everything = `${view.preview}\n${decoded(view.mailto!)}`;
      expect(everything).not.toContain(new URL(baseUrl).host);
      expect(everything).not.toContain(new URL(baseUrl).hostname);
    }
  });

  it("throws at build for a host address that is not one plain address", async () => {
    for (const supportEmail of ["a@b.example?bcc=x@y.example", "a@b.example,c@d.example", "a b@c.example", "a@b.example\n", "100%@b.example", "x".repeat(250) + "@b.example", ""]) {
      await expect(standalone({ options: { supportEmail } }), JSON.stringify(supportEmail)).rejects.toThrow(TypeError);
    }
  });

  it("throws for a bad host address in governed mode too, where it would never be used", async () => {
    await expect(governed({ options: { supportEmail: "a@b.example?bcc=x@y.example" } })).rejects.toThrow(TypeError);
  });
});

describe("what is never in the report", () => {
  it("leaves out every prompt, answer, reasoning, file name, tool argument and result, the person's address and the agent's key", async () => {
    const model: FakeModel = (r) => {
      if (lastToolResults(r).size > 0) return { reasoning: SECRET_REASONING, text: SECRET_ANSWER };
      return { toolCalls: [{ name: "lookup", arguments: { query: SECRET_ARGUMENT } }] };
    };
    const { chat, clipboard, opened, builder } = await governed({
      model, browserLog: true, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }), app: { name: "Word add-in", version: "1.2.0" },
    });
    chat.attach({ title: SECRET_FILE, content: "payroll data", kind: "page" });
    await chat.send(SECRET_PROMPT);
    expect(chat.turns[0]!.state).toBe("completed");
    chat.openReportProblem({ code: "agent_disabled", requestId: "req-1" });
    const view = chat.reportProblem;
    expect(chat.writeReportMail()).toBe(true);
    expect(await chat.copyReportDetails()).toBe(true);
    const texts = [view.preview, view.mailto!, decoded(view.mailto!), clipboard.lastText!, opened.join("\n"), view.goesTo, view.noChats];
    for (const secret of [SECRET_PROMPT, SECRET_ARGUMENT, SECRET_RESULT, SECRET_ANSWER, SECRET_REASONING, SECRET_FILE, "payroll", "user@example.com", "hunter2"]) {
      for (const text of texts) expect(text, secret).not.toContain(secret);
    }
    // The SDK's own log line "Tool lookup (read, host) ended ok" names the tool: in the copy the entry stays (event, outcome) and the
    // name is masked; the mail never has the log.
    for (const text of [...texts, ...texts.map(decoded)]) expect(text).not.toContain("lookup");
    const copied = clipboard.lastText!;
    expect(copied).toMatch(/Fadenstack\.Agents 2020 Tool \[tool\] \(read, \[name\]\) ended ok in \d+ ms, approval none/);
    expect(decoded(view.mailto!).startsWith("mailto:it@corp.example?subject=Problem with Word add-in 1.2.0")).toBe(true);
    expect(await builder.browserLog!.entries()).not.toHaveLength(0); // the log has entries, so the copy below is a real check
  });

  it("puts the browser log's last entries in the copy, and never in the mail", async () => {
    const { chat, clipboard, builder } = await governed({ browserLog: true, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }), model: () => ({ text: "ok" }) });
    await chat.send("Hello");
    const entries = await builder.browserLog!.entries();
    expect(entries.length).toBeGreaterThan(0);
    expect(await chat.copyReportDetails()).toBe(true);
    const text = clipboard.lastText!;
    const [body, log] = text.split("\n-- \nRecent log:\n");
    expect(body!.startsWith("To: it@corp.example\nSubject: Problem with Fadenstack SDK ")).toBe(true);
    const logged = log!.split("\n");
    expect(logged).toHaveLength(Math.min(50, entries.length));
    const last = entries.at(-1)!;
    expect(logged.at(-1)).toBe(`${last.at} ${last.level} ${last.category} ${last.eventId} ${last.message}`);
    const view = chat.reportProblem;
    for (const mail of [view.preview, decoded(view.mailto!)]) {
      expect(mail).not.toContain("Recent log");
      expect(mail).not.toContain(last.category);
      expect(mail).not.toContain(last.at);
    }
  });

  it("copies the last 50 entries only", async () => {
    const { chat, clipboard, builder } = await governed({ browserLog: true, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    const log = builder.browserLog!;
    for (let i = 0; i < 70; i++) log.log({ category: "Fadenstack.Agents", eventId: 2000, eventName: "Test", level: "warning", message: `entry-${i}`, fields: {} });
    await chat.copyReportDetails();
    const logged = clipboard.lastText!.split("\n-- \nRecent log:\n")[1]!.split("\n");
    expect(logged).toHaveLength(50);
    expect(logged[0]).toContain("entry-20");
    expect(logged.at(-1)).toContain("entry-69");
  });

  it("has no log section for an agent without a browser log", async () => {
    const { chat, clipboard } = await governed({ policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    await chat.copyReportDetails();
    expect(clipboard.lastText).not.toContain("Recent log");
  });

  it("reports a clipboard that refuses", async () => {
    const { chat } = await governed({ options: { clipboard: { setText: () => Promise.reject(new Error("No focus.")) } } });
    expect(await chat.copyReportDetails()).toBe(false);
  });
});

describe("a failed turn's link", () => {
  const failing: FakeModel = () => ({ badRequest: { code: "picture_type_not_allowed", param: "messages.0.content.1", message: "raw server text" } });

  it("opens the sheet with the error's code; nothing else of the turn goes with it", async () => {
    const { chat } = await governed({ model: failing, policy: MachinePolicy.from({ supportEmail: "it@corp.example" }) });
    await chat.send(SECRET_PROMPT);
    const turn = chat.turns[0]!;
    expect(turn.state).toBe("failed");
    expect(turn.canReportProblem).toBe(true);
    turn.reportProblem();
    expect(chat.isReportProblemOpen).toBe(true);
    const preview = chat.reportProblem.preview;
    expect(lines(preview).at(-1)).toBe("Error: picture_type_not_allowed");
    expect(preview).not.toContain(SECRET_PROMPT);
    expect(preview).not.toContain("raw server text");
  });

  it("is offered on a failed turn only", async () => {
    const { chat } = await governed({ model: () => ({ text: "fine" }) });
    await chat.send("Hi");
    expect(chat.turns[0]!.canReportProblem).toBe(false);
    chat.turns[0]!.reportProblem();
    expect(chat.isReportProblemOpen).toBe(false);
  });

  it("names a server error without a code by its status", async () => {
    const { chat } = await governed({ model: () => ({ badRequest: { code: "bad code with spaces", message: "x" } }) });
    await chat.send("Hi");
    chat.turns[0]!.reportProblem();
    expect(lines(chat.reportProblem.preview).at(-1)).toBe("Error: http_400");
  });
});
