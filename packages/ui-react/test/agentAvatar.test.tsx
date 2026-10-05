// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentAvatar } from "@fadenstack/ui-react";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("is decorative unless it has a label", () => {
    const { container } = render(<AgentAvatar />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    render(<AgentAvatar label="Page assistant" />);
    expect(screen.getByRole("img", { name: "Page assistant" })).toBeTruthy();
  });

  it("draws the small cut up to 32 px and the full cut above", () => {
    const { container } = render(<><AgentAvatar size={24} /><AgentAvatar size={64} /></>);
    const [small, full] = Array.from(container.querySelectorAll("svg"));
    expect(small!.getAttribute("viewBox")).toBe("19.5 25 161 161");
    expect(full!.getAttribute("viewBox")).toBe("21 30 158 158");
    // only the full cut has the loose thread end and the hollow under the lid
    expect(small!.querySelectorAll("ellipse")).toHaveLength(2);
    expect(full!.querySelectorAll("ellipse")).toHaveLength(3);
  });

  it("gives a custom agent its own thread colour", () => {
    const { container } = render(<AgentAvatar color="#0E9F9A" />);
    expect(container.querySelector("svg")!.getAttribute("style")).toContain("--fdn-agent-thread: #0E9F9A");
  });

  it("keeps each silhouette's masks to itself", () => {
    const { container } = render(<><AgentAvatar variant="mono" /><AgentAvatar variant="mono" size={24} /></>);
    const ids = Array.from(container.querySelectorAll("mask")).map((m) => m.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    for (const use of Array.from(container.querySelectorAll("[mask]"))) {
      expect(ids).toContain(use.getAttribute("mask")!.slice(5, -1));
    }
  });
});
