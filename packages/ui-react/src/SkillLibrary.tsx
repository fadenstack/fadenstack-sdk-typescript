import { useId, useRef, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import type { SkillLibraryViewModel, SkillRowViewModel, UiStrings } from "@fadenstack/ui";
import { readFileBytes } from "@fadenstack/ui-web";

import { Spinner } from "./icons.js";
import { useViewModel } from "./hooks.js";
import { SkillEditorBody, editorEscape } from "./SkillEditor.js";
import { Actions, Alert, Ask, Button, Issues, Shell, Title, defaultStrings, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface SkillLibraryProps extends SkillViewProps {
  /** The library's view model; the app calls `refresh()` (and `retext()` when the language changes). */
  library: SkillLibraryViewModel;
}

/**
 * The skill library (sdk/51 F04) in the wizard's column: the skills with where each comes from, "not reviewed" for the person's own and
 * its switch; New and Import; Edit (View for a bundled one), Duplicate, Export and Delete on each row, with the confirmations the view
 * model asks for. When an editor is open (new, edit, a draft's proposal) it is drawn in place of the list. Import is a file input for a
 * zip (and the library's own drop point, `importFrom`); Export is the app's `SkillFileHost.saveExport` (`browserSkillFiles()` is a
 * download). Every command is called in the click's own turn.
 */
export function SkillLibrary(props: SkillLibraryProps): ReactElement {
  const { strings = defaultStrings } = props;
  const vm = useViewModel(props.library);
  const s = strings();
  const id = useId();
  const column = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const editor = vm.editor;
  const asking = vm.pendingDelete !== undefined ? "delete" : vm.pendingImport !== undefined ? "import" : "list";

  // The list's first button, or the question that opened (the editor focuses itself).
  useFirstFocus(column, [editor === undefined, asking], editor === undefined);

  const onKeyDown = (e: KeyboardEvent) => {
    if (editor) return editorEscape(editor, e);
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (vm.pendingDelete) vm.cancelDelete();
    else if (vm.pendingImport) vm.cancelImport();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // the same file can be chosen again
    if (!file) return;
    void readFileBytes(file).then((bytes) => vm.importFrom({ name: file.name, bytes })).catch(() => undefined);
  };

  const confirmImport = (e: FormEvent) => {
    e.preventDefault();
    void vm.confirmImport();
  };

  const pending = vm.pendingImport;
  return (
    <Shell s={s} theme={props.theme} className={props.className} busy={vm.isLoading || (editor?.isSaving ?? false)} onKeyDown={onKeyDown} columnRef={column}>
      {editor ? <SkillEditorBody editor={editor} strings={strings} /> : (
        <>
          <Title>{s.skillLibraryTitle}</Title>
          {vm.message && <p className="fdn-skills-message" role="status" dir="auto">{vm.message}</p>}
          {vm.note && (vm.failed
            ? <Alert>{vm.note}</Alert>
            : <p className="fdn-wizard-busy" role="status" dir="auto">{vm.isLoading && <Spinner />}<span>{vm.note}</span></p>)}

          <Actions>
            <Button primary disabled={!vm.canNew} focus={asking === "list"} onClick={() => vm.newSkill()}>{s.skillNew}</Button>
            <Button disabled={!vm.canImport} onClick={() => picker.current?.click()}>{s.skillImport}</Button>
          </Actions>
          <label htmlFor={`${id}-zip`} className="fdn-sr-only">{s.skillImport}</label>
          <input id={`${id}-zip`} ref={picker} className="fdn-sr-only" type="file" accept=".zip" tabIndex={-1} aria-hidden="true" onChange={chosen} />

          {vm.pendingDelete && (
            <Ask id={`${id}-delete`} title={vm.deleteTitle} body={vm.deleteBody}>
              <Actions>
                <Button focus onClick={() => vm.cancelDelete()}>{s.skillCancel}</Button>
                <Button primary disabled={!vm.canConfirmDelete} onClick={() => void vm.confirmDelete()}>{s.skillDelete}</Button>
              </Actions>
            </Ask>
          )}

          {pending && (
            <form onSubmit={confirmImport} noValidate>
              <Ask id={`${id}-import`} title={vm.importTitle} body={vm.importBody}>
                <Issues items={vm.importIssues} />
                <Actions>
                  <Button focus={!vm.canConfirmImport || vm.importReplaces} onClick={() => vm.cancelImport()}>{s.skillCancel}</Button>
                  {pending.ok && (
                    <Button primary submit disabled={!vm.canConfirmImport} focus={vm.canConfirmImport && !vm.importReplaces}>
                      {vm.importReplaces ? s.skillReplace : s.skillImport}
                    </Button>
                  )}
                </Actions>
              </Ask>
            </form>
          )}

          {vm.rows.length > 0 && (
            <ul className="fdn-skills-list">
              {vm.rows.map((row) => <RowView key={row.name} library={vm} row={row} s={s} />)}
            </ul>
          )}
        </>
      )}
    </Shell>
  );
}

function RowView({ library, row: model, s }: { library: SkillLibraryViewModel; row: SkillRowViewModel; s: UiStrings }): ReactElement {
  const row = useViewModel(model);
  const id = useId();
  return (
    <li className="fdn-card fdn-skills-row" aria-labelledby={`${id}-name`}>
      <div className="fdn-skills-row-head">
        <div>
          <div id={`${id}-name`} className="fdn-skills-name" dir="auto">{row.name}</div>
          <div className="fdn-muted" dir="auto">{row.description}</div>
        </div>
        {library.canToggle(row) && (
          <label className="fdn-skills-switch">
            <input type="checkbox" role="switch" checked={row.isEnabled} aria-label={row.name} onChange={() => void library.toggle(row)} />
            <span>{row.switchLabel}</span>
          </label>
        )}
      </div>
      <div className="fdn-skills-badges">
        <span className="fdn-badge" dir="auto">{row.originLabel}</span>
        {row.isNotReviewed && <span className="fdn-badge fdn-class-write" dir="auto">{row.statusLabel}</span>}
      </div>
      <div className="fdn-wizard-actions">
        {row.canOpen && <Button disabled={!library.canEdit(row)} describedBy={`${id}-name`} onClick={() => void library.edit(row)}>{row.isReadOnly ? s.skillView : s.skillEdit}</Button>}
        {row.canDuplicate && <Button quiet disabled={!library.canDuplicate(row)} describedBy={`${id}-name`} onClick={() => void library.duplicate(row)}>{s.skillDuplicate}</Button>}
        {row.canExport && <Button quiet disabled={!library.canExport(row)} describedBy={`${id}-name`} onClick={() => void library.export(row)}>{s.skillExport}</Button>}
        {library.canAskDelete(row) && <Button quiet describedBy={`${id}-name`} onClick={() => library.askDelete(row)}>{s.skillDelete}</Button>}
      </div>
    </li>
  );
}
