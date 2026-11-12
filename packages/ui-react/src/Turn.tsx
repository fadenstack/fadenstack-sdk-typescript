import { memo, useEffect, useRef, useState, type ReactElement } from "react";

import type { TurnViewModel, UiStrings } from "@fadenstack/ui";
import { COPIED_MS, turnMeta } from "@fadenstack/ui-web";

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
  // "Saved as a prompt" shows for a moment, as "Copied" does.
  const [saveNote, setSaveNote] = useState<{ saved: boolean; message: string } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const savePrompt = () => {
    void turn.savePrompt().then((result) => {
      setSaveNote(result);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaveNote(undefined), COPIED_MS);
    });
  };
  return (
    <article className="fdn-turn" aria-busy={turn.isRunning}>
      <div className={`fdn-user${turn.isPromptBlocked ? " fdn-user-blocked" : ""}`}>
        <div className="fdn-user-bubble" dir="auto">
          {turn.userText}
          {turn.attachments.length > 0 && (
            <div className="fdn-chips">
              {turn.attachments.map((a, i) => (
                <span key={i} className={a.skill ? "fdn-chip fdn-chip-static fdn-chip-skill" : "fdn-chip fdn-chip-static"} title={a.subtitle}>
                  {a.image ? <img className="fdn-chip-image" src={a.image} alt="" /> : <Icon name={a.skill ? "sparkle" : "page"} size={12} />}
                  <span className="fdn-chip-title" dir="auto">{a.title}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {turn.isPromptBlocked && (
          <div className="fdn-user-note">
            <span>{strings.notSent}</span>
            {turn.canEdit && <button type="button" className="fdn-link" onClick={() => turn.edit()}>{strings.editAndResend}</button>}
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
            {turn.canEdit && <button type="button" className="fdn-icon-button fdn-small" title={strings.edit} aria-label={strings.edit} onClick={() => turn.edit()}>
              <Icon name="edit" size={14} />
            </button>}
            {turn.canSavePrompt && (
              <button type="button" className="fdn-icon-button fdn-small" title={saveNote?.saved ? saveNote.message : strings.savePrompt}
                aria-label={strings.savePrompt} onClick={savePrompt}>
                <Icon name={saveNote?.saved ? "check" : "bookmark"} size={14} />
              </button>
            )}
            {saveNote && <span className={saveNote.saved ? "fdn-muted" : "fdn-muted fdn-error-text"} role="status">{saveNote.message}</span>}
            <span className="fdn-muted">{turnMeta(turn)}</span>
          </div>
        )}
      </div>
    </article>
  );
});
