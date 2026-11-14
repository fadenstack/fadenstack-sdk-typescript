import { useEffect, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";

import { englishStrings, type StringsSource, type UiStrings } from "@fadenstack/ui";

import type { ChatTheme } from "./ChatPanel.js";

// What the skill views share: the shell (the wizard's own column, a little wider), the first-field focus, and the small blocks.

export const defaultStrings: StringsSource = () => englishStrings;

export interface SkillViewProps {
  /** The texts, asked for on every draw so that a language change shows at once: the function the view model was given. English by default. */
  strings?: StringsSource;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
  className?: string;
}

/** A new state takes the focus: its first marked field, else its title, else the column itself. */
export function useFirstFocus(column: RefObject<HTMLElement | null>, deps: readonly unknown[], enabled = true): void {
  useEffect(() => {
    const root = column.current;
    if (!root || !enabled) return;
    const target = root.querySelector<HTMLElement>("[data-wizard-focus]") ?? root.querySelector<HTMLElement>("[data-wizard-title]") ?? root;
    target.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function Shell({ s, theme = "system", className, busy, onKeyDown, columnRef, children }: {
  s: UiStrings; theme?: ChatTheme; className?: string | undefined; busy: boolean; onKeyDown?: ((e: KeyboardEvent) => void) | undefined;
  columnRef: RefObject<HTMLDivElement | null>; children: ReactNode;
}): ReactElement {
  return (
    <div className={`fdn-chat fdn-wizard fdn-skills${className ? ` ${className}` : ""}`} data-theme={theme} lang={s.language} dir={s.direction} onKeyDown={onKeyDown}>
      <div className="fdn-wizard-column fdn-skills-column" ref={columnRef} tabIndex={-1} aria-busy={busy}>
        {children}
      </div>
    </div>
  );
}

export function Title({ children }: { children: ReactNode }): ReactElement {
  return <h2 className="fdn-wizard-title" tabIndex={-1} data-wizard-title="" dir="auto">{children}</h2>;
}

export function Alert({ children, id }: { children: ReactNode; id?: string }): ReactElement {
  return <p id={id} className="fdn-wizard-error" role="alert" dir="auto">{children}</p>;
}

export function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="fdn-wizard-actions">{children}</div>;
}

export function Button({ onClick, children, primary, quiet, disabled, submit, form, focus, describedBy }: {
  onClick?: () => void; children: ReactNode; primary?: boolean; quiet?: boolean; disabled?: boolean; submit?: boolean; form?: string;
  focus?: boolean; describedBy?: string;
}): ReactElement {
  const cls = `fdn-button${primary ? " fdn-primary" : ""}${quiet ? " fdn-quiet" : ""}`;
  return (
    <button type={submit ? "submit" : "button"} className={cls} disabled={disabled} onClick={onClick} form={form}
      aria-describedby={describedBy} data-wizard-focus={focus ? "" : undefined} dir="auto">
      {children}
    </button>
  );
}

export function Field({ label, id, children }: { label: string; id: string; children: ReactElement }): ReactElement {
  return (
    <div className="fdn-wizard-field">
      <label htmlFor={id} dir="auto">{label}</label>
      {children}
    </div>
  );
}

/** "Delete this?" / "Replace it?": a heading, the words, and the answers, announced when it appears. */
export function Ask({ id, title, body, children }: { id: string; title: string; body?: string | undefined; children: ReactNode }): ReactElement {
  return (
    <div className="fdn-card fdn-skills-ask" role="group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} role="alert" dir="auto">{title}</h3>
      {body && <p dir="auto">{body}</p>}
      {children}
    </div>
  );
}

export function Issues({ items, id }: { items: readonly { text: string; isError: boolean }[]; id?: string | undefined }): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul id={id} className="fdn-skills-issues">
      {items.map((item, i) => <li key={i} className={`fdn-skills-issue${item.isError ? " fdn-skills-issue-error" : ""}`} dir="auto">{item.text}</li>)}
    </ul>
  );
}
