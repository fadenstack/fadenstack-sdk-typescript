import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  NoticePart,
  chineseSimplifiedStrings,
  englishStrings,
  frenchStrings,
  germanStrings,
  immediateScheduler,
  spanishStrings,
  type UiStrings,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";
import { testServices } from "./services.js";

// The owner's note for a refusal with `images_disabled` (core 0.7.1, EU AI Act Article 5), in the panel's language. The .NET
// SDK's ImagesDisabledNoticeTests.

const EN = "Image generation is turned off in this version. From 2 December 2026 the EU AI Act (Article 5) requires safeguards against generating harmful images, and this version does not have them yet. Image generation will return in a later version, with those safeguards.";
const DE = "Die Bilderzeugung ist in dieser Version ausgeschaltet. Ab dem 2. Dezember 2026 verlangt die EU-KI-Verordnung (Artikel 5) Schutzmaßnahmen gegen das Erzeugen schädlicher Bilder, und diese Version hat sie noch nicht. Die Bilderzeugung kommt in einer späteren Version mit diesen Schutzmaßnahmen zurück.";

async function chat() {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", name: "Page", images: true, contract: [{ name: "insert_image", risk: "read" }] }],
    model: (r) => (lastToolResults(r).size ? { text: "I could not." } : { toolCalls: [{ name: "insert_image", arguments: { prompt: "a cat" } }] }),
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(approvals)
    .addTools(defineTool({
      name: "insert_image", toolClass: "read", makesPictures: true,
      run: () => client.transport.post(client.transport.gateway("v1/agents/page/images/generations"), { prompt: "a cat" }),
    }))
    .build();
  const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler });
  await vm.initialize();
  return { vm };
}

describe("the notice for image generation being off", () => {
  it("shows the owner's note and its title, not the server's message, and changes language with the panel", async () => {
    const { vm } = await chat();
    await vm.send("A cat, please.");
    const notice = vm.turns[0]!.parts.find((p) => p instanceof NoticePart) as NoticePart;
    expect(notice).toMatchObject({ severity: "warning", title: "Image generation is off", message: EN });

    await vm.setLanguage("de");
    expect(notice).toMatchObject({ title: "Bilderzeugung ist ausgeschaltet", message: DE });
    await vm.setLanguage("en");
    expect(notice.message).toBe(EN);
  });

  it("is in every language, naming the regulation as it is called there", () => {
    const table: [UiStrings, string, string][] = [
      [englishStrings, "Image generation is off", "EU AI Act (Article 5)"],
      [germanStrings, "Bilderzeugung ist ausgeschaltet", "EU-KI-Verordnung (Artikel 5)"],
      [frenchStrings, "La génération d’images est désactivée", "règlement européen sur l’IA (article 5)"],
      [spanishStrings, "La generación de imágenes está desactivada", "Reglamento europeo de IA (artículo 5)"],
      [chineseSimplifiedStrings, "图像生成已关闭", "欧盟《人工智能法》（第 5 条）"],
    ];
    for (const [strings, title, regulation] of table) {
      expect(strings.noticeTitles["images_disabled"]).toBe(title);
      expect(strings.imagesDisabled).toContain(regulation);
      expect(strings.imagesDisabled).toContain("2026");
    }
    expect(englishStrings.imagesDisabled).toBe(EN);
    expect(germanStrings.imagesDisabled).toBe(DE);
  });
});
