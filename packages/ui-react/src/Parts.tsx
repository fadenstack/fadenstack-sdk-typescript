import type { ReactElement } from "react";

import {
  ApprovalPart,
  CardPart,
  CitationsPart,
  DiffPart,
  MarkdownPart,
  NoticePart,
  ProgressPart,
  ReasoningPart,
  TablePart,
  ToolCallPart,
  type ResponsePart,
  type UiStrings,
} from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon, Spinner } from "./icons.js";
import { Markdown } from "./Markdown.js";

/** Views for parts modules add; tried before the built-in ones. Return null to pass. */
export type PartRenderer = (part: ResponsePart, strings: UiStrings) => ReactElement | null;

export function PartView({ part, strings, renderers }: { part: ResponsePart; strings: UiStrings; renderers?: readonly PartRenderer[] }): ReactElement | null {
  for (const render of renderers ?? []) {
    const view = render(part, strings);
    if (view) return view;
  }
  if (part instanceof MarkdownPart) return <MarkdownView part={part} strings={strings} />;
  if (part instanceof ToolCallPart) return <ToolCallView part={part} strings={strings} />;
  if (part instanceof ApprovalPart) return <ApprovalView part={part} strings={strings} />;
  if (part instanceof NoticePart) return <NoticeView part={part} />;
  if (part instanceof ReasoningPart) return <ReasoningView part={part} />;
  if (part instanceof CitationsPart) return <CitationsView part={part} />;
  if (part instanceof CardPart) return <CardView part={part} />;
  if (part instanceof TablePart) return <TableView part={part} />;
  if (part instanceof ProgressPart) return <ProgressView part={part} />;
  if (part instanceof DiffPart) return <DiffView part={part} />;
  return null;
}

function MarkdownView({ part, strings }: { part: MarkdownPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  return <Markdown blocks={part.blocks} strings={strings} streaming={part.isStreaming} onCopyCode={(code) => part.copyCode(code)} />;
}

function ToolCallView({ part, strings }: { part: ToolCallPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  const failed = part.state === "failed";
  const denied = part.state === "denied" || part.state === "cancelled";
  return (
    <div className={`fdn-tool${failed ? " fdn-tool-failed" : ""}${denied ? " fdn-tool-denied" : ""}`}>
      <button type="button" className="fdn-tool-line" aria-expanded={part.isExpanded} disabled={!part.hasDetails}
        onClick={() => part.toggle()}>
        <span className="fdn-tool-status">
          {part.isRunning ? <Spinner /> : <Icon name={failed ? "warning" : denied ? "close" : "check"} size={14} />}
        </span>
        <span className="fdn-tool-title">{part.title}</span>
        {part.source !== "host" && <span className="fdn-badge">{part.source === "gateway" ? strings.serverTool : part.source}</span>}
        {part.source === "host" && part.toolClass !== "read" && (
          <span className={`fdn-badge fdn-class-${part.toolClass}`}>{part.classLabel}</span>
        )}
        <span className="fdn-tool-duration">{part.durationText}</span>
        {part.hasDetails && <span className={part.isExpanded ? "fdn-chevron fdn-open" : "fdn-chevron"}><Icon name="chevron" size={14} /></span>}
      </button>
      {part.isExpanded && (
        <div className="fdn-tool-details">
          {part.argumentsText && (
            <>
              <div className="fdn-label">{strings.arguments}</div>
              <pre>{part.argumentsText}</pre>
            </>
          )}
          {part.resultText && (
            <>
              <div className="fdn-label">{strings.result}</div>
              <pre>{part.resultText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalView({ part, strings }: { part: ApprovalPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  return (
    <div className={`fdn-approval${part.isDangerous ? " fdn-approval-danger" : ""}`} role="group" aria-label={part.title}>
      <div className="fdn-approval-head">
        <Icon name={part.isDangerous ? "warning" : "shield"} />
        <strong>{part.title}</strong>
        <span className={`fdn-badge fdn-class-${part.request.toolClass}`}>{part.classLabel}</span>
      </div>
      {part.reason && <p className="fdn-approval-reason">{part.reason}</p>}
      {part.argumentsText && <pre className="fdn-approval-args">{part.argumentsText}</pre>}
      {part.isPending ? (
        <div className="fdn-approval-actions">
          <button type="button" className="fdn-button fdn-primary" onClick={() => part.allow()}>{strings.allow}</button>
          <button type="button" className="fdn-button" onClick={() => part.allowForSession()}>{strings.allowForChat}</button>
          <button type="button" className="fdn-button fdn-quiet" onClick={() => part.deny()}>{strings.deny}</button>
        </div>
      ) : (
        <div className={`fdn-approval-state fdn-approval-${part.state}`}>{part.stateText}</div>
      )}
    </div>
  );
}

function NoticeView({ part }: { part: NoticePart }): ReactElement {
  const icon = part.severity === "info" ? "info" : part.severity === "blocked" ? "shield" : "warning";
  return (
    <div className={`fdn-notice fdn-notice-${part.severity}`} role={part.severity === "info" ? "note" : "alert"}>
      <Icon name={icon} />
      <div>
        <strong>{part.title}</strong>
        <div>{part.message}</div>
        {part.detail && <div className="fdn-notice-detail">{part.detail}</div>}
      </div>
    </div>
  );
}

function ReasoningView({ part }: { part: ReasoningPart }): ReactElement {
  useViewModel(part);
  return (
    <div className="fdn-collapsible">
      <button type="button" className="fdn-collapsible-head" aria-expanded={part.isExpanded} onClick={() => part.toggle()}>
        {part.isStreaming ? <Spinner /> : <Icon name="brain" size={14} />}
        <span>{part.title}</span>
        <span className={part.isExpanded ? "fdn-chevron fdn-open" : "fdn-chevron"}><Icon name="chevron" size={14} /></span>
      </button>
      {part.isExpanded && <div className="fdn-reasoning">{part.text}</div>}
    </div>
  );
}

function CitationsView({ part }: { part: CitationsPart }): ReactElement {
  useViewModel(part);
  return (
    <div className="fdn-collapsible">
      <button type="button" className="fdn-collapsible-head" aria-expanded={part.isExpanded} onClick={() => part.toggle()}>
        <Icon name="book" size={14} />
        <span>{part.title}</span>
        <span className={part.isExpanded ? "fdn-chevron fdn-open" : "fdn-chevron"}><Icon name="chevron" size={14} /></span>
      </button>
      {part.isExpanded && (
        <ol className="fdn-citations">
          {part.citations.map((c, i) => (
            <li key={i}>
              {c.title}
              {c.detail && <span className="fdn-muted"> · {c.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CardView({ part }: { part: CardPart }): ReactElement {
  return (
    <div className="fdn-card">
      <strong>{part.title}</strong>
      {part.subtitle && <div className="fdn-muted">{part.subtitle}</div>}
      <dl>
        {part.fields.map((f, i) => (
          <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function TableView({ part }: { part: TablePart }): ReactElement {
  return (
    <div className="fdn-md-table">
      {part.title && <div className="fdn-label">{part.title}</div>}
      <table>
        <thead><tr>{part.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{part.rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function ProgressView({ part }: { part: ProgressPart }): ReactElement {
  useViewModel(part);
  return (
    <div className="fdn-progress">
      <span>{part.label}</span>
      <progress value={part.value} max={1} aria-label={part.label} />
    </div>
  );
}

function DiffView({ part }: { part: DiffPart }): ReactElement {
  return (
    <div className="fdn-diff">
      <div className="fdn-label">{part.title}</div>
      <pre>
        {part.lines.map((l, i) => (
          <div key={i} className={`fdn-diff-${l.kind}`}>{l.kind === "added" ? "+ " : l.kind === "removed" ? "- " : "  "}{l.text}</div>
        ))}
      </pre>
    </div>
  );
}
