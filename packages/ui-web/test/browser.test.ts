// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserChatServices,
  browserClipboard,
  browserOpenLink,
  browserPreferences,
  browserPromptStore,
  browserSaveFile,
} from "@fadenstack/ui-web";

// The browser's ways for what the chat panel needs from its host; @fadenstack/ui has no browser default of its own
// (sdk/52 P4, owner 13 Nov). These moved here from @fadenstack/ui with their tests.

const BOM = String.fromCharCode(0xfeff);

afterEach(() => {
  vi.unstubAllGlobals(); // first: a test may have taken localStorage away
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browserPreferences", () => {
  it("keeps a choice in localStorage under the standalone principal's key, for every panel of the site", () => {
    browserPreferences().set("language", "de");
    expect(localStorage.getItem("fadenstack.language:standalone:standalone")).toBe("de");
    expect(browserPreferences().get("language")).toBe("de");
    browserPreferences().set("language", undefined);
    expect(localStorage.getItem("fadenstack.language:standalone:standalone")).toBeNull();
  });

  it("keeps two people's choices apart, follows the person the chat names, and knows no one before", () => {
    let who: { principal: { tenantId: string; userId: string } | undefined } | undefined;
    const store = browserPreferences();
    store.followPerson(() => who);
    store.set("language", "lost"); // no one is known yet: nothing is written
    expect(store.get("language")).toBeUndefined();
    expect(localStorage.length).toBe(0);
    who = { principal: { tenantId: "t", userId: "anna" } };
    store.set("language", "de");
    who = { principal: { tenantId: "t", userId: "ben" } };
    expect(store.get("language")).toBeUndefined();
    store.set("language", "fr");
    expect(localStorage.getItem("fadenstack.language:t:anna")).toBe("de");
    expect(localStorage.getItem("fadenstack.language:t:ben")).toBe("fr");
    who = { principal: { tenantId: "t", userId: "anna" } };
    expect(store.get("language")).toBe("de");
    who = { principal: undefined }; // a server that names no user: the shared key, as before
    store.set("language", "it");
    expect(localStorage.getItem("fadenstack.language")).toBe("it");
  });

  it("lets only the standalone principal adopt the old shared key, until it has its own", () => {
    localStorage.setItem("fadenstack.language", "es");
    const store = browserPreferences();
    expect(store.get("language")).toBe("es");
    store.set("language", "pt");
    expect(store.get("language")).toBe("pt");
    expect(localStorage.getItem("fadenstack.language")).toBe("es"); // left alone
    store.set("language", undefined); // forgotten stays forgotten, the old key does not come back
    expect(store.get("language")).toBe("");
    const governed = browserPreferences({ principal: { tenantId: "t", userId: "anna" } });
    expect(governed.get("language")).toBeUndefined();
  });

  it("keeps a choice in memory when the browser refuses to store it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const store = browserPreferences();
    store.set("language", "fr");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(store.get("language")).toBe("fr");
  });
});

describe("browserPromptStore", () => {
  it("keeps the list in localStorage under the person's own key, shared by every store on the page", async () => {
    const a = browserPromptStore({ now: () => new Date("2026-11-13T10:00:00Z") });
    const saved = await a.save("Kept");
    expect(JSON.parse(localStorage.getItem("fadenstack.prompts:standalone:standalone")!)).toEqual([saved]);
    expect((await browserPromptStore().list()).map((p) => p.text)).toEqual(["Kept"]);
    await a.remove(saved.id);
    expect(await browserPromptStore().list()).toEqual([]);
  });

  it("keeps two people's prompts apart and adopts the old shared list for the standalone principal only", async () => {
    localStorage.setItem("fadenstack.prompts", JSON.stringify([{ id: "o", title: "Old", text: "Old", savedAt: "" }]));
    expect((await browserPromptStore().list()).map((p) => p.text)).toEqual(["Old"]);
    expect(await browserPromptStore({ principal: { tenantId: "t", userId: "anna" } }).list()).toEqual([]);
    const anna = browserPromptStore({ principal: { tenantId: "t", userId: "anna" } });
    await anna.save("Annas");
    expect((await browserPromptStore({ principal: { tenantId: "t", userId: "ben" } }).list())).toEqual([]);
    const standalone = browserPromptStore();
    await standalone.save("New");
    expect((await standalone.list()).map((p) => p.text)).toEqual(["New", "Old"]); // the old list was read, then written under the person's key
    expect(localStorage.getItem("fadenstack.prompts:t:anna")).toContain("Annas");
  });

  it("refuses a save while whose prompts these are is not known", async () => {
    const store = browserPromptStore();
    store.followPerson(() => undefined);
    expect(await store.list()).toEqual([]);
    await expect(store.save("x")).rejects.toThrow();
    expect(localStorage.length).toBe(0);
  });

  it("is a memory store where there is no localStorage", async () => {
    vi.stubGlobal("localStorage", undefined);
    const store = browserPromptStore();
    await store.save("x");
    expect((await store.list()).length).toBe(1);
  });
});

describe("browserOpenLink", () => {
  it("opens the link in a new tab with no way back to the panel and no Referer", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    browserOpenLink("https://fadenstack.com/?ref=sdk-about");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://fadenstack.com/?ref=sdk-about", "_blank", "noopener,noreferrer");
  });
});

describe("browserClipboard", () => {
  it("writes the text to the browser's clipboard, and does nothing where there is none", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await browserClipboard.setText("copied");
    expect(writeText).toHaveBeenCalledWith("copied");
    vi.stubGlobal("navigator", {});
    expect(browserClipboard.setText("nowhere")).toBeUndefined();
  });
});

describe("browserSaveFile", () => {
  it("does nothing where there is no page", () => {
    vi.stubGlobal("document", undefined);
    expect(() => browserSaveFile({ name: "x.csv", type: "text/csv", content: "a" })).not.toThrow();
  });

  it("makes a temporary link with the file's name, clicks it, and releases the object URL once the download surely began", () => {
    vi.useFakeTimers();
    const doc = { createElement: vi.fn(), body: { appendChild: vi.fn() } };
    const link = { href: "", download: "", rel: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    doc.createElement.mockReturnValue(link);
    vi.stubGlobal("document", doc);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      browserSaveFile({ name: "table.csv", type: "text/csv", content: `${BOM}a` });
      expect(link.download).toBe("table.csv");
      expect(link.href).toBe("blob:fake");
      expect(link.click).toHaveBeenCalledOnce();
      expect(link.remove).toHaveBeenCalledOnce();
      expect((create.mock.calls[0]![0] as Blob).type).toBe("text/csv;charset=utf-8");
      // Revoked at once, a download that has not started yet may be cancelled.
      vi.advanceTimersByTime(1000);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(40_000);
      expect(revoke).toHaveBeenCalledWith("blob:fake");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browserChatServices", () => {
  it("gives the browser's four a chat panel needs, and the choices it keeps outlive the page", () => {
    const services = browserChatServices();
    expect(services.clipboard).toBe(browserClipboard);
    expect(services.openLink).toBe(browserOpenLink);
    expect(services.saveFile).toBe(browserSaveFile);
    services.preferences.set("language", "fr");
    expect(localStorage.getItem("fadenstack.language:standalone:standalone")).toBe("fr");
    expect(browserChatServices().preferences.get("language")).toBe("fr");
  });
});
