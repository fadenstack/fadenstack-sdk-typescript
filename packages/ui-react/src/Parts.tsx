import { useCallback, type ReactElement } from "react";

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
import { approvalIcon, diffMarker, noticeIcon, noticeRole, toolBadges, toolClassName, toolStatusIcon } from "@fadenstack/ui-web";

import { useViewModel } from "./hooks.js";
import { Icon, Spinner } from "./icons.js";
import { Markdown } from "./Markdown.js";

/** Views for parts modules add; tried before the built-in ones, again whenever the part changes. Return null to pass. */
export type PartRenderer = (part: ResponsePart, strings: UiStrings) => ReactElement | null;

export function PartView({ part, strings, renderers }: { part: ResponsePart; strings: UiStrings; renderers?: readonly PartRenderer[] }): ReactElement | null {
  useViewModel(part);
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

export function MarkdownView({ part, strings }: { part: MarkdownPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  // Stable callbacks, so blocks that did not change are not rendered again while the answer streams.
  const copyCode = useCallback((code: string) => part.copyCode(code), [part]);
  const copyTable = useCallback((table: Parameters<MarkdownPart["copyTable"]>[0]) => part.copyTable(table), [part]);
  return <Markdown blocks={part.blocks} strings={strings} streaming={part.isStreaming} onCopyCode={copyCode} onCopyTable={copyTable} />;
}

export function ToolCallView({ part, strings }: { part: ToolCallPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  const status = toolStatusIcon(part);
  return (
    <div className={toolClassName(part)}>
      <button type="button" className="fdn-tool-line" aria-expanded={part.isExpanded} disabled={!part.hasDetails}
        onClick={() => part.toggle()}>
        <span className="fdn-tool-status">{status ? <Icon name={status} size={14} /> : <Spinner />}</span>
        <span className="fdn-tool-title">{part.title}</span>
        {toolBadges(part, strings).map((badge) => <span key={badge.className} className={badge.className}>{badge.text}</span>)}
        <span className="fdn-tool-duration">{part.durationText}</span>
        {part.hasDetails && <span className={part.isExpanded ? "fdn-chevron fdn-open" : "fdn-chevron"}><Icon name="chevron" size={14} /></span>}
      </button>
      {part.isExpanded && (
        <div className="fdn-tool-details">
          {part.argumentsText && (
            <>
              <div className="fdn-label">{strings.arguments}</div>
              <pre dir="auto">{part.argumentsText}</pre>
            </>
          )}
          {part.resultText && (
            <>
              <div className="fdn-label">{strings.result}</div>
              <pre dir="auto">{part.resultText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalView({ part, strings }: { part: ApprovalPart; strings: UiStrings }): ReactElement {
  useViewModel(part);
  return (
    <div className={`fdn-approval${part.isDangerous ? " fdn-approval-danger" : ""}`} role="group" aria-label={part.title}>
      <div className="fdn-approval-head">
        <Icon name={approvalIcon(part)} />
        <strong>{part.title}</strong>
        <span className={`fdn-badge fdn-class-${part.request.toolClass}`}>{part.classLabel}</span>
      </div>
      {part.reason && <p className="fdn-approval-reason" dir="auto">{part.reason}</p>}
      {part.argumentsText && <pre className="fdn-approval-args" dir="auto">{part.argumentsText}</pre>}
      {part.isPending ? (
        <div className="fdn-approval-actions">
          <button type="button" className="fdn-button fdn-primary" onClick={() => part.allow()}>{strings.allow}</button>
          {part.canAllowForSession && (
            <button type="button" className="fdn-button" onClick={() => part.allowForSession()}>{strings.allowForChat}</button>
          )}
          {part.canAllowAlways && (
            <button type="button" className="fdn-button" onClick={() => part.allowAlways()}>{strings.allowAlways}</button>
          )}
          <button type="button" className="fdn-button fdn-quiet" onClick={() => part.deny()}>{strings.deny}</button>
        </div>
      ) : (
        <div className={`fdn-approval-state fdn-approval-${part.state}`}>{part.stateText}</div>
      )}
    </div>
  );
}

export function NoticeView({ part }: { part: NoticePart; strings?: UiStrings }): ReactElement {
  return (
    <div className={`fdn-notice fdn-notice-${part.severity}`} role={noticeRole(part.severity)}>
      <Icon name={noticeIcon(part.severity)} />
      <div dir="auto">
        <strong>{part.title}</strong>
        <div>{part.message}</div>
        {part.detail && <div className="fdn-notice-detail">{part.detail}</div>}
      </div>
    </div>
  );
}

export function ReasoningView({ part }: { part: ReasoningPart; strings?: UiStrings }): ReactElement {
  useViewModel(part);
  return (
    <div className="fdn-collapsible">
      <button type="button" className="fdn-collapsible-head" aria-expanded={part.isExpanded} onClick={() => part.toggle()}>
        {part.isStreaming ? <Spinner /> : <Icon name="brain" size={14} />}
        <span>{part.title}</span>
        <span className={part.isExpanded ? "fdn-chevron fdn-open" : "fdn-chevron"}><Icon name="chevron" size={14} /></span>
      </button>
      {part.isExpanded && <div className="fdn-reasoning" dir="auto">{part.text}</div>}
    </div>
  );
}

export function CitationsView({ part }: { part: CitationsPart; strings?: UiStrings }): ReactElement {
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
            <li key={i} dir="auto">
              {c.title}
              {c.detail && <span className="fdn-muted"> · {c.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CardView({ part }: { part: CardPart; strings?: UiStrings }): ReactElement {
  return (
    <div className="fdn-card" dir="auto">
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

export function TableView({ part }: { part: TablePart; strings?: UiStrings }): ReactElement {
  return (
    <div className="fdn-md-table">
      {part.title && <div className="fdn-label">{part.title}</div>}
      <table dir="auto">
        <thead><tr>{part.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{part.rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function ProgressView({ part }: { part: ProgressPart; strings?: UiStrings }): ReactElement {
  useViewModel(part);
  return (
    <div className="fdn-progress">
      <span>{part.label}</span>
      <progress value={part.value} max={1} aria-label={part.label} />
    </div>
  );
}

export function DiffView({ part }: { part: DiffPart; strings?: UiStrings }): ReactElement {
  return (
    <div className="fdn-diff">
      <div className="fdn-label">{part.title}</div>
      <pre>
        {part.lines.map((l, i) => (
          <div key={i} className={`fdn-diff-${l.kind}`}>{diffMarker(l.kind)}{l.text}</div>
        ))}
      </pre>
    </div>
  );
}
