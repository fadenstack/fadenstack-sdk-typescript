import { describe, expect, it } from "vitest";

import { EndpointDialect, EndpointReport } from "@fadenstack/client";
import { AgentDefinition, FadenstackAgent, MemoryApprovalStore, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, englishStrings, immediateScheduler } from "@fadenstack/ui";
import { OpenAiFake } from "@fadenstack/testing";
import { testServices } from "./services.js";

// A standalone agent's panel: pictures when the model's vision is not known (F2), no thinking pill where the dialect has no
// switch (F7), and what Off says when the model thinks anyway (F10). Governed behaviour is in skillsPictures.test.ts and reasoningPill.test.ts.

const DEFINITION = { slug: "local-assistant", name: "Local", version: { instructions: "Hi.", host_tool_contract: [], ui: {} } };
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

function report(over: { vision?: boolean | null; thinksWhenOff?: boolean | null; dialect?: string } = {}): EndpointReport {
  return new EndpointReport({
    baseUrl: "http://localhost:11434/v1", model: "m", checkedAt: 0, server: "Ollama", serverVersion: null, dialect: over.dialect ?? "ollama",
    reachable: true, keyAccepted: true, models: ["m"], chat: true, usage: true, toolCalls: true, vision: over.vision ?? null,
    thinksWhenOff: over.thinksWhenOff ?? null, contextLength: null, modelContextLength: null, pictures: false,
    watermark: { status: "Unknown", source: null, checked: null, requested: false, confirmed: null }, problems: [],
  });
}

async function standalone(dialect: EndpointDialect, saved?: EndpointReport) {
  const fake = new OpenAiFake();
  const agent = FadenstackAgent.createBuilder()
    .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "m", dialect, fetch: fake.fetch }, saved)
    .useLocalProfile(AgentDefinition.fromJson(DEFINITION))
    .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore()).build();
  const approvals = new ApprovalBroker();
  const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, automaticLanguage: "en" });
  await vm.initialize();
  return { vm, agent, fake };
}

describe("pictures on a standalone agent (F2)", () => {
  it("a model whose vision is not known (a connection saved before the check looked) accepts a picture", async () => {
    const { vm } = await standalone(EndpointDialect.ollama, report({ vision: null }));
    expect(vm.canAttachPictures).toBe(true);
    expect(vm.attachPicture({ dataUrl: PICTURE })).toBe(true);
    expect(vm.error).toBeUndefined();
  });

  it("a model checked to see pictures accepts one", async () => {
    const { vm } = await standalone(EndpointDialect.ollama, report({ vision: true }));
    expect(vm.canAttachPictures).toBe(true);
  });

  it("a model checked not to see pictures refuses with the sentence", async () => {
    const { vm } = await standalone(EndpointDialect.ollama, report({ vision: false }));
    expect(vm.canAttachPictures).toBe(false);
    expect(vm.attachPicture({ dataUrl: PICTURE })).toBe(false);
    expect(vm.attachments).toEqual([]);
    expect(vm.error).toBe("This agent's model does not see pictures.");
  });
});

describe("the thinking pill on a standalone agent (F7)", () => {
  it.each([[EndpointDialect.openAiCompatible], [EndpointDialect.lmStudio]])("is not shown on %j", async (dialect) => {
    const { vm } = await standalone(dialect);
    expect(vm.reasoningOptions).toEqual([]);
    expect(vm.offersReasoning).toBe(false);
  });

  it.each([[EndpointDialect.ollama], [EndpointDialect.openRouter], [EndpointDialect.vllm]])("is shown, with its levels, on %j", async (dialect) => {
    const { vm } = await standalone(dialect);
    expect(vm.offersReasoning).toBe(true);
    expect(vm.reasoningOptions.map((o) => o.level)).toEqual(["auto", "off", "low", "medium", "high"]);
  });
});

describe("what Off says when the model thinks anyway (F10)", () => {
  const off = (vm: AgentChatViewModel) => vm.reasoningOptions.find((o) => o.level === "off")!.description;

  it("a reasoning_effort dialect: Off uses the lowest level", async () => {
    const { vm } = await standalone(EndpointDialect.ollama, report({ thinksWhenOff: true }));
    expect(off(vm)).toBe("This model always thinks. Off uses its lowest level.");
    expect(off(vm)).toBe(englishStrings.reasoningOffLowest);
  });

  it("a chat-template dialect: the model thinks even when Off", async () => {
    const { vm } = await standalone(EndpointDialect.vllm, report({ thinksWhenOff: true, dialect: "vllm" }));
    expect(off(vm)).toBe("This model thinks even when Off.");
  });

  it("otherwise Off keeps its own line", async () => {
    const { vm } = await standalone(EndpointDialect.ollama, report({ thinksWhenOff: false }));
    expect(off(vm)).toBe("Answers at once.");
    const none = await standalone(EndpointDialect.ollama);
    expect(off(none.vm)).toBe("Answers at once.");
  });
});
