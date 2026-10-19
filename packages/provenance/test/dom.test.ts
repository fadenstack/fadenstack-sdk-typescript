// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { textSha256 } from "@fadenstack/client";
import { englishStrings } from "@fadenstack/ui";
import { ProvenanceReader, keepsOwnModel, readerTextSha256, splitMarksAt, unnestMarks, wrapHtml } from "@fadenstack/provenance";

/**
 * The rule on a page's DOM, as a browser host (the Chrome extension) applies it to an editor: the same cases as the
 * HTML text's (`mark-split-vectors.json`), and lifting a mark an editor put inside another.
 */
const R1 = "5a0e2b5c-7f3e-4a51-9a40-6a1c55e1d3f1";
const R2 = "0b6f9a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const S1 = `<span data-ai-generated="${R1}" title="AI-generated ${R1}">`;
const S2 = `<span data-ai-generated="${R2}" title="AI-generated ${R2}">`;
const reader = new ProvenanceReader();

/** An editor holding `html`, and the place its `|` stands for (the `|` taken out). */
function editor(html: string): { root: HTMLElement; range: Range } {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  root.innerHTML = html;
  document.body.replaceChildren(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf("|");
    if (at < 0) continue;
    const range = document.createRange();
    if (node.data === "|") {
      range.setStartBefore(node);
      node.remove();
    } else {
      node.data = node.data.replace("|", "");
      range.setStart(node, at);
    }
    range.collapse(true);
    return { root, range };
  }
  throw new Error(`no | in ${html}`);
}

/** The editor's HTML with `|` where `range` is. */
function shown(root: HTMLElement, range: Range): string {
  const bar = document.createTextNode("|");
  range.insertNode(bar);
  const html = root.innerHTML;
  bar.remove();
  return html;
}

/** Whether an element of a record's mark has another record's mark around it. */
function nested(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll("[data-ai-generated]")).some((el) => {
    const own = el.getAttribute("data-ai-generated");
    for (let at = el.parentElement; at && at !== root; at = at.parentElement) {
      const around = at.getAttribute("data-ai-generated");
      if (around && around !== own) return true;
    }
    return false;
  });
}

function insert(range: Range, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  range.insertNode(template.content);
}

describe("splitMarksAt: a place for a later write in an editor, in no mark", () => {
  const vectors = (JSON.parse(readFileSync(resolve("packages/provenance/test/fixtures/mark-split-vectors.json"), "utf8")) as {
    split: { name: string; html: string; split: string; record: string }[];
  }).split;
  const later = wrapHtml("We are sorry for the trouble.", R2, englishStrings.aiGeneratedTitle(R2));

  it.each(vectors.map((v) => [v.name, v] as const))("as on HTML text: %s", async (_, v) => {
    const { root, range } = editor(v.html);
    const place = splitMarksAt(range, root);
    expect(place.collapsed).toBe(true);
    expect(shown(root, place)).toBe(v.split);
    insert(place, later);
    expect(nested(root)).toBe(false);
    expect(await reader.recordTextSha256(root.innerHTML, R1)).toBe(await readerTextSha256(v.record, "text/html"));
    expect(await reader.recordTextSha256(root.innerHTML, R2)).toBe(await textSha256("We are sorry for the trouble."));
  });

  it("leaves the editor as it is for a place in no mark, and for a place outside the editor", () => {
    const { root, range } = editor(`<p>Dear Ms Weber,|</p><p>${S1}Thank you.</span></p>`);
    const before = root.innerHTML;
    const place = splitMarksAt(range, root);
    expect(root.innerHTML).toBe(before);
    expect([place.startContainer, place.startOffset]).toEqual([range.startContainer, range.startOffset]);
    const elsewhere = document.createElement("div");
    expect(splitMarksAt(range, elsewhere).startContainer).toBe(range.startContainer);
  });
});

describe("keepsOwnModel: the editors whose DOM is not to be split", () => {
  it.each([
    ["CKEditor 5", '<div class="ck ck-editor__editable ck-content" contenteditable="true"><p id="at">x</p></div>'],
    ["ProseMirror", '<div class="ProseMirror" contenteditable="true"><p id="at">x</p></div>'],
    ["Quill", '<div class="ql-editor" contenteditable="true"><p id="at">x</p></div>'],
    ["Lexical", '<div data-lexical-editor="true" contenteditable="true"><p id="at">x</p></div>'],
    ["Slate", '<div data-slate-editor="true" contenteditable="true"><p id="at">x</p></div>'],
    ["Draft.js", '<div class="public-DraftEditor-content" contenteditable="true"><div id="at">x</div></div>'],
  ])("%s draws its DOM from a model of its own", (_name, html) => {
    document.body.innerHTML = html;
    expect(keepsOwnModel(document.getElementById("at")!)).toBe(true);
  });

  it("a plain contenteditable, TinyMCE's body or a page's form does not", () => {
    document.body.innerHTML = '<div contenteditable="true"><p id="plain">x</p></div><body-like id="tiny" class="mce-content-body"></body-like>';
    expect(keepsOwnModel(document.getElementById("plain")!)).toBe(false);
    expect(keepsOwnModel(document.getElementById("tiny")!)).toBe(false);
  });
});

describe("unnestMarks: a mark an editor put inside another is lifted out of it", () => {
  it("where Chrome puts a write at a mark's edge: inside the next half", async () => {
    // What Chrome's insertHTML made of a write placed between the two halves of R1 (the live run).
    const root = editor(`<p>&nbsp;${S1}Thank you for your report.</span>${S1}&nbsp;${S2}We are sorry for the trouble.</span>&nbsp;We will ` +
      "replace the <strong>seal MS-40</strong> on Thursday.</span>|</p>").root;
    expect(unnestMarks(root)).toBe(1);
    expect(root.innerHTML).toBe(`<p>&nbsp;${S1}Thank you for your report.</span>${S1}&nbsp;</span>${S2}We are sorry for the trouble.</span>` +
      `${S1}&nbsp;We will replace the <strong>seal MS-40</strong> on Thursday.</span></p>`);
    expect(await reader.recordTextSha256(root.innerHTML, R1))
      .toBe(await readerTextSha256("<p>Thank you for your report. We will replace the <strong>seal MS-40</strong> on Thursday.</p>", "text/html"));
  });

  it("keeps the formatting the write was in, and lifts it out of a block mark too", () => {
    const inline = editor(`<p>${S1}One <b>two ${S2}new</span> three</b> four.</span>|</p>`).root;
    expect(unnestMarks(inline)).toBe(1);
    expect(inline.innerHTML).toBe(`<p>${S1}One <b>two </b></span><b>${S2}new</span></b>${S1}<b> three</b> four.</span></p>`);
    const block = editor(`<div data-ai-generated="${R1}" title="AI-generated ${R1}"><p>One.</p><div data-ai-generated="${R2}" ` +
      `title="AI-generated ${R2}"><p>New.</p></div><p>Two.|</p></div>`).root;
    expect(unnestMarks(block)).toBe(1);
    expect(block.innerHTML).toBe(`<div><p>${S1}One.</span></p><div data-ai-generated="${R2}" title="AI-generated ${R2}"><p>New.</p></div>` +
      `<p>${S1}Two.</span></p></div>`);
    expect(nested(block)).toBe(false);
  });

  it("lifts nothing where nothing is nested", () => {
    const root = editor(`<p>${S1}One.</span> ${S2}Two.</span>|</p>`).root;
    const before = root.innerHTML;
    expect(unnestMarks(root)).toBe(0);
    expect(root.innerHTML).toBe(before);
  });
});
