import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, type StopAllResult } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, NoticePart, StopEverythingViewModel, builtInStrings, describeStopResult, englishStrings, immediateScheduler,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";
import { testServices } from "./services.js";

// "Stop everything" and the chat of an agent the organisation turned off: the states, the result line and its five languages. The .NET
// SDK's Fadenstack.UI.Tests.StopEverythingTests.

const result = (turnsStopped: number, grantsEnded: number, grantsNotTold = 0): StopAllResult => ({ turnsStopped, grantsEnded, chatApprovalsEnded: 0, grantsNotTold });
const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

describe("the texts", () => {
  it("exist in five languages, and the console's own words are kept", () => {
    for (const language of LANGUAGES) {
      const s = builtInStrings[language]!;
      for (const key of ["agentTurnedOff", "agentTurnedOffCheckAgain", "stopEverything", "stopEverythingTip", "stopEverythingBusy", "stopEverythingNothing", "grantsEndedByOff"] as const) {
        expect(s[key].length, `${language} ${key}`).toBeGreaterThan(0);
      }
      expect(s.noticeTitles["agent_disabled"], language).toBeTruthy();
      expect(s.bypassEnded.agent_turned_off, language).toBeTruthy();
    }
    expect(builtInStrings["en"]!.agentTurnedOff).toBe("Your organisation turned this agent off.");
    expect(builtInStrings["de"]!.agentTurnedOff).toBe("Ihre Organisation hat diesen Agenten ausgeschaltet.");
    expect(builtInStrings["fr"]!.agentTurnedOff).toBe("Votre organisation a éteint cet agent.");
    expect(builtInStrings["es"]!.agentTurnedOff).toBe("Su organización apagó este agente.");
    expect(builtInStrings["zh-Hans"]!.agentTurnedOff).toBe("您的组织已关闭此智能体。");
  });

  it.each([
    [2, 3, 0, "Stopped 2 chats and ended 3 grants."],
    [1, 1, 0, "Stopped 1 chat and ended 1 grant."],
    [0, 0, 0, "Nothing was running."],
    [2, 0, 0, "Stopped 2 chats."],
    [0, 4, 0, "Ended 4 grants."],
    [1, 2, 1, "Stopped. The server could not be told about 1 grant; it ends at its time."],
  ])("the result line for %i turns, %i grants and %i not told is %s", (turns, grants, notTold, expected) => {
    expect(describeStopResult(result(turns, grants, notTold), englishStrings)).toBe(expected);
  });

  it("speaks each language, and is empty before the first press", () => {
    expect(describeStopResult(undefined, englishStrings)).toBe("");
    const r = result(2, 3);
    expect(describeStopResult(r, builtInStrings["de"]!)).toBe("2 Chats gestoppt und 3 Freigaben beendet.");
    expect(describeStopResult(r, builtInStrings["fr"]!)).toBe("Arrêté : 2 conversations. Terminé : 3 autorisations.");
    expect(describeStopResult(r, builtInStrings["es"]!)).toBe("Detenido: 2 chats. Terminado: 3 permisos.");
    expect(describeStopResult(r, builtInStrings["zh-Hans"]!)).toBe("已停止 2 个聊天，并结束 3 项授权。");
  });
});

describe("the Stop everything control", () => {
  it("stops at once with no confirmation, shows busy and then the result, and not twice at once", async () => {
    let release!: (r: StopAllResult) => void;
    const asked: number[] = [];
    const vm = new StopEverythingViewModel({ agents: () => [], stop: (agents) => { asked.push(agents.length); return new Promise((resolve) => { release = resolve; }); } });
    expect(vm.name).toBe("Stop everything");
    expect(vm.resultText).toBe("");

    const pressing = vm.stop();
    expect(vm.isBusy).toBe(true);
    expect(vm.canStop).toBe(false);
    expect(vm.resultText).toBe("Stopping...");
    await vm.stop(); // a second press while it works does nothing
    release(result(1, 2));
    await pressing;

    expect(vm.isBusy).toBe(false);
    expect(vm.resultText).toBe("Stopped 1 chat and ended 2 grants.");
    expect(asked).toEqual([0]); // asked once, with no confirmation step
    expect(vm.canStop).toBe(true);
  });

  it("still ends when the stop itself fails after the local part", async () => {
    const vm = new StopEverythingViewModel({ agents: () => [], stop: () => Promise.reject(new Error("down")) });
    await vm.stop();
    expect(vm.isBusy).toBe(false);
    expect(vm.resultText).toBe("Nothing was running.");
  });

  it("stops a real agent's chats", async () => {
    const { agent, vm } = await chat(false);
    const control = new StopEverythingViewModel({ agents: () => [agent] });
    await control.stop();
    expect(control.resultText).toBe("Nothing was running.");
    vm.dispose();
  });
});

async function chat(off: boolean, model?: FakeModel) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page", contract: [{ name: "read_page", risk: "read" }] }], model: model ?? (() => ({ text: "Back." })) });
  if (off) gateway.turnOff();
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler });
  await vm.initialize();
  return { gateway, agent, vm };
}

describe("the chat of an agent that is off", () => {
  it("shows the notice, disables the input, and check again brings it back", async () => {
    const { gateway, vm } = await chat(true);
    await vm.setLanguage("de");
    vm.setInput("Hallo");

    expect(vm.isAgentOff).toBe(true);
    expect(vm.agentOffText).toBe("Ihre Organisation hat diesen Agenten ausgeschaltet.");
    expect(vm.checkAgainText).toBe("Erneut prüfen");
    expect(vm.isInputEnabled).toBe(false);
    expect(vm.canSend).toBe(false);

    gateway.turnOn();
    await vm.checkAgain();

    expect(vm.isAgentOff).toBe(false);
    expect(vm.isInputEnabled).toBe(true);
    expect(vm.canSend).toBe(true);
    expect(gateway.refusedWhileOff()).toEqual([]);
    vm.dispose();
  });

  it("ends the turn that hits the switch with the same sentence, in the panel's language, and the grants view says they ended", async () => {
    let gatewayRef: FakeGateway | undefined;
    const { gateway, vm } = await chat(false, (request) => {
      if (lastToolResults(request).size) return { text: "Nie." };
      gatewayRef?.turnOff();
      return { toolCalls: [{ id: "a", name: "read_page", arguments: {} }] };
    });
    gatewayRef = gateway;
    await vm.setLanguage("de");
    let changes = 0;
    vm.subscribe(() => { changes++; });

    await vm.send("Lies.");

    const notice = vm.turns.at(-1)!.parts.find((p) => p instanceof NoticePart) as NoticePart;
    expect(notice).toMatchObject({ title: "Agent ausgeschaltet", message: "Ihre Organisation hat diesen Agenten ausgeschaltet." });
    expect(vm.turns.at(-1)!.outcome).toBe("agent_disabled");
    expect(vm.isAgentOff).toBe(true);
    expect(changes).toBeGreaterThan(0);
    expect(vm.grants.isAgentOff).toBe(true);
    expect(vm.grants.agentOffGrantsText).toBe("Ihre Organisation hat diesen Agenten ausgeschaltet; seine Freigaben sind beendet.");
    expect(vm.canSend).toBe(false);
    vm.dispose();
  });
});

