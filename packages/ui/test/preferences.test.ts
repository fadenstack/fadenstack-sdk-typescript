// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserPreferences } from "@fadenstack/ui";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("browserPreferences", () => {
  it("keeps a choice in localStorage, for every panel of the site", () => {
    browserPreferences().set("language", "de");
    expect(localStorage.getItem("fadenstack.language")).toBe("de");
    expect(browserPreferences().get("language")).toBe("de");
    browserPreferences().set("language", undefined);
    expect(localStorage.getItem("fadenstack.language")).toBeNull();
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
