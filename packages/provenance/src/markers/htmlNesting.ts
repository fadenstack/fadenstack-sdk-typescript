import { normalizeText, textSha256 } from "@fadenstack/client";

import { DROPPED, VOID, isBlockElement, scanHtml, textOfHtml } from "../readerText.js";
import { recordIdInTitle, titleTemplates, type TitleTemplate } from "../titles.js";
import { AI_GENERATED_ATTRIBUTE, markOf, tagAttributes, type TagAttribute } from "./htmlAttribute.js";

/**
 * Marks never nest. What an agent writes later into HTML that holds an earlier mark goes beside that mark, not into
 * it: the earlier element is split at the place into two siblings that both carry its `data-ai-generated` and title,
 * and the new write goes between them as its own marked element. Every element then holds the text of exactly one
 * record, and a record's text is read from all the elements that carry its id (`recordText`).
 *
 * An inline mark (a `span`) is split where the write goes. A block mark (a `div` around several blocks) is not split
 * inside a line, which would break the line in two: it first takes the form of a one-paragraph mark -- a `span` with
 * its attribute and title around the text of each line, the `div` left without them -- and the span at the place is
 * split. A half with nothing in it goes, so a write at the very start or end of a mark goes beside it.
 *
 * `splitMarksInHtml` does this to HTML text, as the .NET SDK's `HtmlAttributeMarker.SplitMarksAt` does
 * (`mark-split-vectors.json` is the test); `splitMarksAt` does it to a page's DOM, and `unnestMarks` lifts a mark out
 * of another that an editor put it in all the same (Chrome puts what it inserts at the edge of an element inside it).
 *
 * Not in an editor that draws its DOM from a model of its own (`keepsOwnModel`): it redraws from the model, and what
 * was done to its DOM is undone, or worse, the earlier mark goes (CKEditor 5 dropped it in a live run). There a write
 * goes in through the editor, a mark may hold another, and a record's text is still read right: `recordText` leaves
 * out what other records' elements inside hold.
 */

/**
 * Editors that draw their DOM from a model of their own: CKEditor 5, ProseMirror (and Tiptap, built on it), Quill,
 * Lexical, Slate and Draft.js. The Chrome extension found them on the editors' demo pages (19 October 2026).
 */
export const MODEL_EDITOR_SELECTORS =
  ".ck-editor__editable, .ProseMirror, .ql-editor, [data-lexical-editor], [data-slate-editor], .public-DraftEditor-content";

/** Whether `el` is, or is inside, an editor with a model of its own: not one to split or unnest marks in. */
export function keepsOwnModel(el: Element): boolean {
  return el.closest(MODEL_EDITOR_SELECTORS) !== null;
}

const BOM = String.fromCharCode(0xfeff);

/** Elements people see that hold no text: a half or a line with one of them is not empty. */
const REPLACED = new Set([
  "audio", "button", "canvas", "embed", "iframe", "img", "input", "math", "meter", "object", "picture", "progress", "select", "svg",
  "textarea", "video",
]);

// -- reading ---------------------------------------------------------------------------------------

/**
 * The text a reader sees of one record in HTML: the text of every element that carries its id (`data-ai-generated`,
 * or a title of ours), in document order, without what elements of other records and visible labels inside them
 * hold. A mark split in two by a later write reads as its record's text again. Block elements are line breaks
 * wherever they are, as in `htmlText`: white space, which hashing makes one space.
 */
export function recordText(html: string, recordId: string, templates: readonly TitleTemplate[] = titleTemplates()): string {
  // The open elements and the record whose text each holds: its own mark's, none for a label, else its parent's.
  const open: { name: string; record: string | null | undefined }[] = [];
  return textOfHtml(html.startsWith(BOM) ? html.slice(1) : html, {
    get keeping() {
      return open.at(-1)?.record === recordId;
    },
    tag(name, closing, attributes, selfClosing) {
      if (closing) {
        for (let k = open.length - 1; k >= 0; k--) {
          if (open[k]!.name === name) {
            open.length = k;
            break;
          }
        }
      } else if (!selfClosing && !VOID.has(name)) {
        const mark = markOf(tagAttributes(attributes), templates);
        open.push({ name, record: mark === undefined ? open.at(-1)?.record : mark });
      }
    },
  });
}

/**
 * SHA-256 of a record's text in HTML (`recordText`), normalised as content is hashed, hex: the record's
 * `text_sha256` when the text is still the record's. Undefined when the HTML holds none of its text.
 */
export async function recordTextSha256(html: string, recordId: string, templates?: readonly TitleTemplate[]): Promise<string | undefined> {
  const text = normalizeText(recordText(html, recordId, templates));
  return text ? textSha256(text) : undefined;
}

// -- the rule, on a page's DOM and on HTML text alike ----------------------------------------------

/** What the rule does to a tree of HTML, as a page's DOM and the tree of an HTML text both do it. */
interface Tree<N> {
  parent(node: N): N | null;
  children(node: N): N[];
  /** An element's name in lower case; undefined for anything else. */
  element(node: N): string | undefined;
  /** A text's characters (the place's marker is an empty one); undefined for anything else (a comment). */
  text(node: N): string | undefined;
  /** The record an element's mark names; null for a visible label; undefined for anything else. */
  mark(node: N): string | null | undefined;
  insertBefore(parent: N, node: N, before: N | null): void;
  remove(node: N): void;
  /** A copy of an element without its children, and without its `id` (an id names one element). */
  clone(node: N): N;
  /** A `span` with the mark of `marked` (its `data-ai-generated`, and its title when it is ours). */
  markedSpan(marked: N): N;
  /** Takes an element's mark off it. */
  unmark(node: N): void;
}

function nextSibling<N>(t: Tree<N>, node: N): N | null {
  const siblings = t.children(t.parent(node)!);
  return siblings[siblings.indexOf(node) + 1] ?? null;
}

/** Whether a half of a split keeps anything: text (white space too), an element people see, a comment. */
function hasContent<N>(t: Tree<N>, node: N): boolean {
  const text = t.text(node);
  if (text !== undefined) return text.length > 0;
  const name = t.element(node);
  if (name === undefined) return true;
  return VOID.has(name) || REPLACED.has(name) || t.children(node).some((c) => hasContent(t, c));
}

/** Whether a run of a line is worth a mark: text other than white space, or an element people see. */
function visible<N>(t: Tree<N>, node: N): boolean {
  const text = t.text(node);
  if (text !== undefined) return /[^ \t\n\f\r]/.test(text);
  const name = t.element(node);
  if (name === undefined || DROPPED.has(name)) return false;
  return REPLACED.has(name) || t.children(node).some((c) => visible(t, c));
}

function holdsBlock<N>(t: Tree<N>, node: N): boolean {
  return t.children(node).some((c) => {
    const name = t.element(c);
    return name !== undefined && (isBlockElement(name) || holdsBlock(t, c));
  });
}

/** Whether a node is part of a line's run: text, a comment, an inline element with no block in it that is no mark. */
function inRun<N>(t: Tree<N>, node: N): boolean {
  const name = t.element(node);
  if (name === undefined) return true;
  return !isBlockElement(name) && !DROPPED.has(name) && t.mark(node) === undefined && !holdsBlock(t, node);
}

/** A mark's text in the form of a one-paragraph mark: a span with its mark around each run of a line in it, and the mark taken off it. */
function demote<N>(t: Tree<N>, marked: N): void {
  const wrap = (element: N) => {
    let run: N[] = [];
    const flush = () => {
      if (run.some((n) => visible(t, n))) {
        const span = t.markedSpan(marked);
        t.insertBefore(element, span, run[0]!);
        for (const n of run) t.insertBefore(span, n, null);
      }
      run = [];
    };
    for (const child of t.children(element)) {
      if (inRun(t, child)) {
        run.push(child);
        continue;
      }
      flush();
      const name = t.element(child);
      // Another record's mark and a label keep what they hold; dropped and void elements hold no line.
      if (name !== undefined && !DROPPED.has(name) && !VOID.has(name) && t.mark(child) === undefined) wrap(child);
    }
    flush();
  };
  wrap(marked);
  t.unmark(marked);
}

/** Splits the inline mark `marked` at `marker`: what follows it goes into a copy after it, the marker between the two. */
function splitAt<N>(t: Tree<N>, marker: N, marked: N): void {
  const path: N[] = [];
  const copies: N[] = [];
  let child = marker;
  let right: N | undefined;
  for (;;) {
    const parent = t.parent(child)!;
    const copy = t.clone(parent);
    if (right !== undefined) t.insertBefore(copy, right, null);
    const siblings = t.children(parent);
    for (const sibling of siblings.slice(siblings.indexOf(child) + 1)) t.insertBefore(copy, sibling, null);
    path.push(parent);
    copies.push(copy);
    right = copy;
    if (parent === marked) break;
    child = parent;
  }
  const after = nextSibling(t, marked);
  t.insertBefore(t.parent(marked)!, marker, after);
  t.insertBefore(t.parent(marked)!, right!, after);
  // The elements the place was in, on either side, inside out: one with nothing left goes.
  for (const node of [...path, ...copies]) if (!hasContent(t, node)) t.remove(node);
}

/** The innermost mark of a record around `node`, below `root`. */
function markAround<N>(t: Tree<N>, node: N, root: N): N | undefined {
  for (let at = t.parent(node); at !== null && at !== root; at = t.parent(at)) {
    if (typeof t.mark(at) === "string") return at;
  }
  return undefined;
}

/** Splits every mark around `marker` below `root` (see the module's notes), so that the marker is in none. */
function splitMarks<N>(t: Tree<N>, marker: N, root: N): void {
  for (let marked = markAround(t, marker, root); marked !== undefined; marked = markAround(t, marker, root)) {
    let blockBetween = false;
    for (let at = t.parent(marker)!; at !== marked; at = t.parent(at)!) blockBetween ||= isBlockElement(t.element(at)!);
    if (blockBetween || isBlockElement(t.element(marked)!)) demote(t, marked);
    else splitAt(t, marker, marked);
  }
}

// -- HTML text -------------------------------------------------------------------------------------

interface TreeElement {
  readonly name: string;
  /** The start tag as written, or as written again without some attributes. */
  start: string;
  /** The end tag as written; "" for an element without one (void, self-closing, never closed, dropped). */
  end: string;
  attributes: readonly TagAttribute[];
  readonly children: TreeNode[];
  parent: TreeElement | null;
}

interface TreeLeaf {
  readonly kind: "text" | "comment";
  readonly text: string;
  parent: TreeElement | null;
}

type TreeNode = TreeElement | TreeLeaf;

const isLeaf = (node: TreeNode): node is TreeLeaf => "kind" in node;

/** A start tag written again with only `attributes`. */
function startTag(element: TreeElement, attributes: readonly TagAttribute[]): string {
  const name = /^<([^\s/>]+)/.exec(element.start)?.[1] ?? element.name;
  return `<${name}${attributes.map((a) => ` ${a.written}`).join("")}>`;
}

function markAttributes(attributes: readonly TagAttribute[], templates: readonly TitleTemplate[]): TagAttribute[] {
  return attributes.filter((a) => a.name === AI_GENERATED_ATTRIBUTE || (a.name === "title" && recordIdInTitle(a.value, templates) !== undefined));
}

function textTree(templates: readonly TitleTemplate[]): Tree<TreeNode> {
  const element = (node: TreeNode) => node as TreeElement;
  return {
    parent: (node) => node.parent,
    children: (node) => (isLeaf(node) ? [] : [...node.children]),
    element: (node) => (isLeaf(node) ? undefined : node.name),
    text: (node) => (isLeaf(node) && node.kind === "text" ? node.text : undefined),
    mark: (node) => (isLeaf(node) ? undefined : markOf(node.attributes, templates)),
    insertBefore(parent, node, before) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const children = element(parent).children;
      children.splice(before === null ? children.length : children.indexOf(before), 0, node);
      node.parent = element(parent);
    },
    remove(node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
    clone(node) {
      const e = element(node);
      const attributes = e.attributes.filter((a) => a.name !== "id");
      const start = attributes.length === e.attributes.length ? e.start : startTag(e, attributes);
      return { name: e.name, start, end: e.end, attributes, children: [], parent: null };
    },
    markedSpan(marked) {
      const attributes = markAttributes(element(marked).attributes, templates);
      return { name: "span", start: `<span${attributes.map((a) => ` ${a.written}`).join("")}>`, end: "</span>", attributes, children: [], parent: null };
    },
    unmark(node) {
      const e = element(node);
      const marks = markAttributes(e.attributes, templates);
      const kept = e.attributes.filter((a) => !marks.includes(a));
      e.start = startTag(e, kept);
      e.attributes = kept;
    },
  };
}

/** A character reference cut at `at`: `&am|p;`. */
const IN_REFERENCE = /&(?:#[0-9]*|#[xX][0-9a-fA-F]*|[A-Za-z][A-Za-z0-9]*)$/;
const REFERENCE_REST = /^[0-9A-Za-z]*;/;

/** HTML as a tree, with an empty text at `at` (the place); a RangeError for a place inside a tag, a comment or a character reference. */
function parse(html: string, at: number): { root: TreeElement; place: TreeLeaf } {
  if (!Number.isInteger(at) || at < 0 || at > html.length) throw new RangeError(`${at} is no place in the HTML`);
  const root: TreeElement = { name: "#root", start: "", end: "", attributes: [], children: [], parent: null };
  let current = root;
  let place: TreeLeaf | undefined;
  const add = (node: TreeNode) => {
    node.parent = current;
    current.children.push(node);
  };
  const text = (from: number, to: number) => from < to && add({ kind: "text", text: html.slice(from, to), parent: null });
  const mark = () => add((place = { kind: "text", text: "", parent: null }));
  scanHtml(html, (piece) => {
    if (place === undefined && at === piece.start) mark();
    const inside = place === undefined && at > piece.start && at < piece.end;
    if (piece.kind === "text") {
      if (!inside) return void text(piece.start, piece.end);
      if (IN_REFERENCE.test(html.slice(piece.start, at)) && REFERENCE_REST.test(html.slice(at, piece.end))) {
        throw new RangeError(`${at} is inside a character reference`);
      }
      text(piece.start, at);
      mark();
      text(at, piece.end);
      return;
    }
    if (inside) throw new RangeError(`${at} is inside a tag or a comment`);
    const written = html.slice(piece.start, piece.end);
    if (piece.kind === "comment") return void add({ kind: "comment", text: written, parent: null });
    if (piece.kind === "dropped") return void add({ name: piece.name, start: written, end: "", attributes: [], children: [], parent: null });
    if (piece.closing) {
      // The open element it ends, and every one opened inside it; an end tag that ends none stays as it is.
      for (let e: TreeElement | null = current; e !== null && e !== root; e = e.parent) {
        if (e.name === piece.name) {
          e.end = written;
          current = e.parent!;
          return;
        }
      }
      return void add({ kind: "comment", text: written, parent: null });
    }
    const element: TreeElement = { name: piece.name, start: written, end: "", attributes: tagAttributes(piece.attributes), children: [], parent: null };
    add(element);
    if (!piece.selfClosing && !VOID.has(piece.name)) current = element;
  });
  if (place === undefined) mark();
  return { root, place: place! };
}

function serialize(node: TreeNode, place: TreeLeaf, out: { html: string; at: number }): void {
  if (node === place) out.at = out.html.length;
  if (isLeaf(node)) {
    out.html += node.text;
    return;
  }
  out.html += node.start;
  for (const child of node.children) serialize(child, place, out);
  out.html += node.end;
}

/**
 * HTML with the marks around `at` split, so that what a host inserts at the returned index is in no mark (see the
 * module's notes): `at` is an index into `html`, in its text or between its tags; a RangeError for one inside a tag,
 * a comment or a character reference. Everything else stays as written. The .NET SDK's
 * `HtmlAttributeMarker.SplitMarksAt` gives the same.
 */
export function splitMarksInHtml(html: string, at: number, templates: readonly TitleTemplate[] = titleTemplates()): { html: string; at: number } {
  const { root, place } = parse(html, at);
  splitMarks(textTree(templates), place as TreeNode, root as TreeNode);
  const out = { html: "", at: 0 };
  serialize(root, place, out);
  return out;
}

// -- a page's DOM ----------------------------------------------------------------------------------

function domTree(doc: Document, templates: readonly TitleTemplate[]): Tree<Node> {
  const isOurs = (a: Attr) => a.name === AI_GENERATED_ATTRIBUTE || (a.name === "title" && recordIdInTitle(a.value, templates) !== undefined);
  return {
    parent: (node) => node.parentNode,
    children: (node) => Array.from(node.childNodes),
    element: (node) => (node.nodeType === 1 ? (node as Element).localName.toLowerCase() : undefined),
    text: (node) => (node.nodeType === 3 ? (node as CharacterData).data : undefined),
    mark: (node) => (node.nodeType === 1
      ? markOf(Array.from((node as Element).attributes, (a) => ({ name: a.name.toLowerCase(), value: a.value.trim() })), templates)
      : undefined),
    insertBefore: (parent, node, before) => void parent.insertBefore(node, before),
    remove: (node) => void node.parentNode?.removeChild(node),
    clone(node) {
      const copy = node.cloneNode(false) as Element;
      copy.removeAttribute("id");
      return copy;
    },
    markedSpan(marked) {
      const span = doc.createElement("span");
      for (const a of Array.from((marked as Element).attributes)) if (isOurs(a)) span.setAttribute(a.name, a.value);
      return span;
    },
    unmark(node) {
      for (const a of Array.from((node as Element).attributes)) if (isOurs(a)) (node as Element).removeAttribute(a.name);
    },
  };
}

/**
 * Where to insert content into `root` (an editor) at `range`'s start without nesting marks: when the place is inside
 * an element of an earlier mark, that element is split there (see the module's notes) and the range returned lies
 * between the two halves, in no mark; elsewhere the editor's DOM stays as it is and the range returned is `range`'s
 * start. Either way a new, collapsed range; `range` itself is left alone. Not for an editor with a model of its own
 * (`keepsOwnModel`).
 */
export function splitMarksAt(range: Range, root: Node, templates: readonly TitleTemplate[] = titleTemplates()): Range {
  const doc = root.ownerDocument ?? (root as Document);
  const t = domTree(doc, templates);
  const out = range.cloneRange();
  out.collapse(true);
  const container = out.startContainer;
  let inMark = false;
  for (let at: Node | null = container; at !== null && at !== root && !inMark; at = at.parentNode) inMark = typeof t.mark(at) === "string";
  if (!inMark || !root.contains(container)) return out;
  const marker = doc.createTextNode("");
  if (container.nodeType === 3) {
    const text = container as Text;
    if (out.startOffset >= text.length) text.parentNode!.insertBefore(marker, text.nextSibling);
    else if (out.startOffset === 0) text.parentNode!.insertBefore(marker, text);
    else text.parentNode!.insertBefore(marker, text.splitText(out.startOffset));
  } else {
    container.insertBefore(marker, container.childNodes[out.startOffset] ?? null);
  }
  splitMarks(t, marker, root);
  out.setStartBefore(marker);
  out.collapse(true);
  marker.parentNode!.removeChild(marker);
  return out;
}

/**
 * Lifts every mark in `root` that is inside an element of another record's mark out of it: the other element is
 * split around it (see the module's notes), so each holds one record's text again. For an editor that put what it
 * inserted inside a mark although the place given was beside it. Returns how many marks were lifted. Not for an
 * editor with a model of its own (`keepsOwnModel`).
 */
export function unnestMarks(root: Node, templates: readonly TitleTemplate[] = titleTemplates()): number {
  const doc = root.ownerDocument ?? (root as Document);
  const t = domTree(doc, templates);
  const nestedMark = (): Element | undefined => {
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return undefined;
    for (const el of Array.from((root as Element).querySelectorAll(`[${AI_GENERATED_ATTRIBUTE}], [title]`))) {
      const own = t.mark(el);
      if (typeof own !== "string") continue;
      for (let at = el.parentNode; at !== null && at !== root; at = at.parentNode) {
        const around = t.mark(at);
        if (typeof around === "string" && around !== own) return el;
      }
    }
    return undefined;
  };
  let lifted = 0;
  for (let el = nestedMark(); el !== undefined && lifted <= 1000; el = nestedMark()) {
    const own = t.mark(el);
    for (const side of ["before", "after"] as const) {
      const marker = doc.createTextNode("");
      el.parentNode!.insertBefore(marker, side === "before" ? el : el.nextSibling);
      splitMarks(t, marker, root);
      marker.parentNode!.removeChild(marker);
    }
    // Each mark of another record still around it now holds it alone (and copies of the elements between): it goes.
    for (let at: Node | null = el.parentNode; at !== null && at !== root;) {
      const up: Node | null = at.parentNode;
      const around = t.mark(at);
      if (typeof around === "string" && around !== own) {
        while (at.firstChild) up!.insertBefore(at.firstChild, at);
        up!.removeChild(at);
      }
      at = up;
    }
    lifted++;
  }
  return lifted;
}
