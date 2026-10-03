import { memo, useState, type ReactElement, type ReactNode } from "react";

import type { Inline, MarkdownBlock, UiStrings } from "@fadenstack/ui";

import { Icon } from "./icons.js";

export interface MarkdownProps {
  blocks: readonly MarkdownBlock[];
  strings: UiStrings;
  /** Copies a code block (the part's clipboard). */
  onCopyCode?: (code: string) => void;
  /** A cursor after the last block while the answer streams. */
  streaming?: boolean;
}

/** Markdown blocks as React elements -- never as HTML. Each block is memoized: while streaming, only the last one re-renders. */
export function Markdown({ blocks, strings, onCopyCode, streaming }: MarkdownProps): ReactElement {
  return (
    <div className={streaming ? "fdn-md fdn-md-streaming" : "fdn-md"}>
      {blocks.map((block) => (
        <Block key={block.key} block={block} strings={strings} onCopyCode={onCopyCode} />
      ))}
    </div>
  );
}

const Block = memo(function Block({ block, strings, onCopyCode }: {
  block: MarkdownBlock;
  strings: UiStrings;
  onCopyCode: ((code: string) => void) | undefined;
}): ReactElement {
  return renderBlock(block, strings, onCopyCode);
});

function renderBlock(block: MarkdownBlock, strings: UiStrings, onCopyCode: ((code: string) => void) | undefined): ReactElement {
  switch (block.kind) {
    case "paragraph":
      return <p>{inlines(block.inlines)}</p>;
    case "heading": {
      const Tag = `h${Math.min(6, block.level + 2)}` as "h3"; // answers sit under the panel's own headings
      return <Tag className={`fdn-md-h${block.level}`}>{inlines(block.inlines)}</Tag>;
    }
    case "code":
      return <CodeBlock language={block.language} code={block.code} complete={block.complete} strings={strings} onCopy={onCopyCode} />;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === undefined ? undefined : "fdn-md-task"}>
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly disabled />}
          {item.blocks.map((b) => (b.kind === "paragraph" ? <span key={b.key} className="fdn-md-li">{inlines(b.inlines)}</span>
            : <Block key={b.key} block={b} strings={strings} onCopyCode={onCopyCode} />))}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return <blockquote>{block.blocks.map((b) => <Block key={b.key} block={b} strings={strings} onCopyCode={onCopyCode} />)}</blockquote>;
    case "table":
      return (
        <div className="fdn-md-table">
          <table>
            <thead>
              <tr>{block.header.map((cell, i) => <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inlines(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, i) => <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inlines(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr />;
  }
}

function CodeBlock({ language, code, complete, strings, onCopy }: {
  language: string | null;
  code: string;
  complete: boolean;
  strings: UiStrings;
  onCopy: ((code: string) => void) | undefined;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fdn-md-code">
      <div className="fdn-md-code-bar">
        <span>{language ?? ""}</span>
        {onCopy && complete && (
          <button
            type="button"
            className="fdn-icon-button fdn-small"
            aria-label={strings.copyCode}
            title={copied ? strings.copied : strings.copyCode}
            onClick={() => {
              onCopy(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        )}
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function inlines(list: readonly Inline[]): ReactNode[] {
  return list.map((inline, i) => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "strong":
        return <strong key={i}>{inlines(inline.children)}</strong>;
      case "em":
        return <em key={i}>{inlines(inline.children)}</em>;
      case "del":
        return <del key={i}>{inlines(inline.children)}</del>;
      case "code":
        return <code key={i}>{inline.text}</code>;
      case "link":
        return <a key={i} href={inline.href} target="_blank" rel="noopener noreferrer" title={inline.href}>{inlines(inline.children)}</a>;
      case "image":
        // Never loaded: a remote image can carry data out. Its alt text, and where it is.
        return <span key={i} className="fdn-md-image" title={inline.href}>[{inline.alt || "image"}]</span>;
      case "break":
        return <br key={i} />;
    }
  });
}
