import { memo, type ReactElement } from "react";

import type { TurnViewModel, UiStrings } from "@fadenstack/ui";
import { turnMeta } from "@fadenstack/ui-web";

import { useViewModel } from "./hooks.js";
import { Icon, Spinner } from "./icons.js";
import { PartView, type PartRenderer } from "./Parts.js";

/** One exchange: the user's message, then the answer's parts in order. Re-renders only when this turn changes. */
export const TurnView = memo(function TurnView({ turn, strings, renderers }: {
  turn: TurnViewModel;
  strings: UiStrings;
  renderers?: readonly PartRenderer[] | undefined;
}): ReactElement {
  useViewModel(turn);
  const done = !turn.isRunning;
  return (
    <article className="fdn-turn" aria-busy={turn.isRunning}>
      <div className={`fdn-user${turn.isPromptBlocked ? " fdn-user-blocked" : ""}`}>
        <div className="fdn-user-bubble" dir="auto">
          {turn.userText}
          {turn.attachments.length > 0 && (
            <div className="fdn-chips">
              {turn.attachments.map((a, i) => (
                <span key={i} className="fdn-chip fdn-chip-static" title={a.subtitle}>
                  <Icon name="page" size={12} />
                  <span className="fdn-chip-title" dir="auto">{a.title}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {turn.isPromptBlocked && (
          <div className="fdn-user-note">
            <span>{strings.notSent}</span>
            <button type="button" className="fdn-link" onClick={() => turn.edit()}>{strings.editAndResend}</button>
          </div>
        )}
      </div>
      <div className="fdn-answer">
        {turn.parts.map((part) => <PartView key={part.key} part={part} strings={strings} renderers={renderers} />)}
        {turn.statusText && (
          <div className="fdn-status">
            {turn.isRunning && <Spinner />}
            <span>{turn.statusText}</span>
            {turn.errorMessage && <span className="fdn-error-text">{turn.errorMessage}</span>}
          </div>
        )}
        {done && !turn.isPromptBlocked && (
          <div className="fdn-turn-actions">
            {turn.answerText && (
              <button type="button" className="fdn-icon-button fdn-small" title={strings.copy} aria-label={strings.copy} onClick={() => turn.copy()}>
                <Icon name="copy" size={14} />
              </button>
            )}
            {turn.canRetry && (
              <button type="button" className="fdn-icon-button fdn-small" title={strings.retry} aria-label={strings.retry} onClick={() => void turn.retry()}>
                <Icon name="retry" size={14} />
              </button>
            )}
            <button type="button" className="fdn-icon-button fdn-small" title={strings.edit} aria-label={strings.edit} onClick={() => turn.edit()}>
              <Icon name="edit" size={14} />
            </button>
            <span className="fdn-muted">{turnMeta(turn)}</span>
          </div>
        )}
      </div>
    </article>
  );
});
