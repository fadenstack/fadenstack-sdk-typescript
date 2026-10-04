import { memo, useMemo, useState, type ReactElement, type ReactNode } from "react";

import type { Inline, MarkdownBlock, UiStrings } from "@fadenstack/ui";

import { Icon } from "./icons.js";

type TableBlock = Extract<MarkdownBlock, { kind: "table" }>;

export interface MarkdownProps {
  blocks: readonly MarkdownBlock[];
  strings: UiStrings;
  /** Copies a code block (the part's clipboard). */
  onCopyCode?: (code: string) => void;
  /** Copies a table (tab-separated and as HTML); without it tables have no copy button. */
  onCopyTable?: (table: TableBlock) => void;
  /** A cursor after the last block while the answer streams. */
  streaming?: boolean;
}

/** What a block's buttons do. */
interface BlockActions {
  copyCode: ((code: string) => void) | undefined;
  copyTable: ((table: TableBlock) => void) | undefined;
}

/** Markdown blocks as React elements -- never as HTML. Each block is memoized: while streaming, only the last one re-renders. */
export function Markdown({ blocks, strings, onCopyCode, onCopyTable, streaming }: MarkdownProps): ReactElement {
  const actions = useMemo<BlockActions>(() => ({ copyCode: onCopyCode, copyTable: onCopyTable }), [onCopyCode, onCopyTable]);
  return (
    <div className={streaming ? "fdn-md fdn-md-streaming" : "fdn-md"}>
      {blocks.map((block) => (
        <Block key={block.key} block={block} strings={strings} actions={actions} />
      ))}
    </div>
  );
}

const Block = memo(function Block({ block, strings, actions }: {
  block: MarkdownBlock;
  strings: UiStrings;
  actions: BlockActions;
}): ReactElement {
  return renderBlock(block, strings, actions);
});

function renderBlock(block: MarkdownBlock, strings: UiStrings, actions: BlockActions): ReactElement {
  switch (block.kind) {
    case "paragraph":
      return <p>{inlines(block.inlines)}</p>;
    case "heading": {
      const Tag = `h${Math.min(6, block.level + 2)}` as "h3"; // answers sit under the panel's own headings
      return <Tag className={`fdn-md-h${block.level}`}>{inlines(block.inlines)}</Tag>;
    }
    case "code":
      return <CodeBlock language={block.language} code={block.code} complete={block.complete} strings={strings} onCopy={actions.copyCode} />;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === undefined ? undefined : "fdn-md-task"}>
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly disabled />}
          {item.blocks.map((b) => (b.kind === "paragraph" ? <span key={b.key} className="fdn-md-li">{inlines(b.inlines)}</span>
            : <Block key={b.key} block={b} strings={strings} actions={actions} />))}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return <blockquote>{block.blocks.map((b) => <Block key={b.key} block={b} strings={strings} actions={actions} />)}</blockquote>;
    case "table":
      return <TableView block={block} strings={strings} onCopy={actions.copyTable} />;
    case "rule":
      return <hr />;
  }
}

/** A copy button that shows a tick for a moment after copying. */
function CopyButton({ label, strings, onCopy }: { label: string; strings: UiStrings; onCopy: () => void }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="fdn-icon-button fdn-small"
      aria-label={label}
      title={copied ? strings.copied : label}
      onClick={() => {
        onCopy();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

function TableView({ block, strings, onCopy }: { block: TableBlock; strings: UiStrings; onCopy: ((table: TableBlock) => void) | undefined }):
  ReactElement {
  return (
    <div className="fdn-md-table">
      <div className="fdn-md-table-scroll">
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
      {onCopy && (
        <div className="fdn-md-table-bar">
          <CopyButton label={strings.copyTable} strings={strings} onCopy={() => onCopy(block)} />
        </div>
      )}
    </div>
  );
}

function CodeBlock({ language, code, complete, strings, onCopy }: {
  language: string | null;
  code: string;
  complete: boolean;
  strings: UiStrings;
  onCopy: ((code: string) => void) | undefined;
}): ReactElement {
  return (
    <div className="fdn-md-code">
      <div className="fdn-md-code-bar">
        <span>{language ?? ""}</span>
        {onCopy && complete && <CopyButton label={strings.copyCode} strings={strings} onCopy={() => onCopy(code)} />}
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
