// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StopEverythingViewModel, builtInStrings } from "@fadenstack/ui";
import { StopEverythingButton } from "@fadenstack/ui-react";
import { computedRules } from "../../ui-web/test/panelLayout.js";

// "Stop everything" in a host's narrow header, React skin (the Vue skin's stopEverythingLayout.test.ts says the same). jsdom has no layout,
// so the rules of styles.css are cascaded onto the real elements (ui-web/test/panelLayout.ts).

afterEach(() => { cleanup(); });

describe("Stop everything in a narrow host header", () => {
  it("is a row with no height or background of its own, and its line breaks only between words", () => {
    const strings = builtInStrings.en!;
    const model = new StopEverythingViewModel({ agents: () => [], strings: () => strings });
    const view = render(<div style={{ width: "160px" }}><StopEverythingButton stop={model} /></div>);
    const root = view.container.querySelector<HTMLElement>(".fdn-stop-everything")!;
    const rules = computedRules(root);
    expect(rules.get("flex-direction")).toBe("row");
    expect(rules.get("height")).toBe("auto");
    expect(rules.get("min-height")).toBe("0");
    expect(rules.get("background")).toBe("transparent");
    expect(rules.get("display")).toBe("inline-flex");
    const line = computedRules(view.container.querySelector<HTMLElement>(".fdn-stop-everything-result")!);
    expect(line.get("overflow-wrap")).toBe("normal"); // never per letter ("St/op/pe/d/1/ch/at.")
    expect(line.get("word-break")).toBe("normal");
    expect(line.get("min-width")).toBe("0");
    expect(computedRules(view.container.querySelector<HTMLElement>(".fdn-stop-everything-button")!).get("flex")).toBe("none");
  });

  it("still lays out as a row where the host sets the same rules itself", () => {
    const model = new StopEverythingViewModel({ agents: () => [], strings: () => builtInStrings.en! });
    const view = render(<StopEverythingButton stop={model} className="host-stop" />);
    const root = view.container.querySelector<HTMLElement>(".fdn-stop-everything")!;
    root.style.flexDirection = "row"; // a host's rule (Nextcloud's own CSS) says what ours says
    root.style.height = "auto";
    expect(computedRules(root).get("flex-direction")).toBe("row");
    expect(computedRules(root).get("height")).toBe("auto");
    expect(root.className).toContain("host-stop");
  });
});

