// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  agentAvatar,
  composerKey,
  diffMarker,
  dismissOnOutside,
  fitToContent,
  headingTag,
  iconPaths,
  noticeIcon,
  noticeRole,
  stickToBottom,
  type SvgNode,
} from "@fadenstack/ui-web";

const all = (node: SvgNode): SvgNode[] => [node, ...(node.children ?? []).flatMap(all)];

describe("agentAvatar", () => {
  it("draws the small cut up to 32 px and the full cut above", () => {
    expect(agentAvatar({ size: 24, idPrefix: "a" }).attrs["viewBox"]).toBe("19.5 25 161 161");
    expect(agentAvatar({ size: 64, idPrefix: "a" }).attrs["viewBox"]).toBe("21 30 158 158");
    expect(all(agentAvatar({ size: 24, idPrefix: "a" })).filter((n) => n.tag === "ellipse")).toHaveLength(2);
    expect(all(agentAvatar({ size: 64, idPrefix: "a" })).filter((n) => n.tag === "ellipse")).toHaveLength(3);
  });

  it("is decorative unless it has a label", () => {
    expect(agentAvatar({ idPrefix: "a" }).attrs).toMatchObject({ "aria-hidden": "true" });
    expect(agentAvatar({ idPrefix: "a", label: "Page assistant" }).attrs).toMatchObject({ role: "img", "aria-label": "Page assistant" });
  });

  it("names the mono masks after the prefix, so two avatars on a page keep their own", () => {
    const ids = (prefix: string) => all(agentAvatar({ variant: "mono", idPrefix: prefix })).filter((n) => n.tag === "mask").map((n) => n.attrs["id"]);
    expect(ids(":r1:")).toEqual(["r1b", "r1m", "r1e"]);
    const uses = all(agentAvatar({ variant: "mono", idPrefix: "x" })).map((n) => n.attrs["mask"]).filter(Boolean);
    expect(uses).toEqual(["url(#xb)", "url(#xm)", "url(#xe)"]);
  });

  it("gives a custom agent its own thread colour", () => {
    expect(agentAvatar({ color: "#0E9F9A", idPrefix: "a" }).style).toMatchObject({ "--fdn-agent-thread": "#0E9F9A" });
    expect(agentAvatar({ idPrefix: "a" }).style).toBeUndefined();
  });
});

describe("the composer's keys", () => {
  it.each([
    [{ key: "Enter", shiftKey: false, isComposing: false }, false, "send"],
    [{ key: "Enter", shiftKey: true, isComposing: false }, false, undefined],
    [{ key: "Enter", shiftKey: false, isComposing: true }, false, undefined],
    [{ key: "Escape", shiftKey: false, isComposing: false }, true, "stop"],
    [{ key: "Escape", shiftKey: false, isComposing: false }, false, undefined],
    [{ key: "a", shiftKey: false, isComposing: false }, true, undefined],
  ])("%o (busy %s) does %s", (e, busy, action) => {
    expect(composerKey(e, busy)).toBe(action);
  });
});

describe("the browser behaviours", () => {
  it("dismiss a menu on a press outside it or Escape, until stopped", () => {
    const anchor = document.body.appendChild(document.createElement("div"));
    const inside = anchor.appendChild(document.createElement("button"));
    const close = vi.fn();
    const stop = dismissOnOutside(anchor, close);
    inside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledTimes(2);
    stop();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("keep a scroll box at the bottom until the reader scrolls up", () => {
    const box = document.createElement("div");
    box.appendChild(document.createElement("div"));
    const metrics = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    for (const [key, value] of Object.entries(metrics)) Object.defineProperty(box, key, { value, writable: true, configurable: true });
    const sticky = stickToBottom(box);
    expect(sticky.stuck).toBe(true);
    box.scrollTop = 300;
    box.dispatchEvent(new Event("scroll"));
    expect(sticky.stuck).toBe(false);
    box.scrollTop = 790;
    box.dispatchEvent(new Event("scroll"));
    expect(sticky.stuck).toBe(true);
    sticky.stop();
  });

  it("grow a text box with its text, up to a third of the window", () => {
    const box = document.createElement("textarea");
    Object.defineProperty(box, "scrollHeight", { value: 80, configurable: true });
    fitToContent(box);
    expect(box.style.height).toBe("80px");
    Object.defineProperty(box, "scrollHeight", { value: 5000, configurable: true });
    fitToContent(box);
    expect(box.style.height).toBe(`${Math.max(120, window.innerHeight / 3)}px`);
  });
});

describe("the presentation", () => {
  it("decides marks and icons once for every skin", () => {
    expect([diffMarker("added"), diffMarker("removed"), diffMarker("context")]).toEqual(["+ ", "- ", "  "]);
    expect([headingTag(1), headingTag(2), headingTag(5)]).toEqual(["h3", "h4", "h6"]);
    expect([noticeIcon("info"), noticeIcon("blocked"), noticeIcon("error")]).toEqual(["info", "shield", "warning"]);
    expect([noticeRole("info"), noticeRole("warning")]).toEqual(["note", "alert"]);
    expect(Object.keys(iconPaths)).toContain("send");
  });
});
