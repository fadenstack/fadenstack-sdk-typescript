import { useEffect, useId, useRef, type KeyboardEvent, type ReactElement } from "react";

import type { MyDataSettingsViewModel } from "@fadenstack/ui";
import { whenShown } from "@fadenstack/ui-web";

import { useViewModel } from "./hooks.js";
import { Actions, Button, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface MyDataSettingsProps extends SkillViewProps {
  /** The control's view model (`new MyDataSettingsViewModel({ agent })`). Call its `load()` once when the page opens (the skin calls `refresh()` each time it is shown); handle its `onSaveRequest`. */
  settings: MyDataSettingsViewModel;
}

/**
 * "Your data in this browser", where an app keeps its settings (GDPR Art. 15, 17 and 20): "Export my data" and "Remove my data…" for this
 * app, "Export all my Fadenstack data" and "Remove all my Fadenstack data in this browser…" for every app. A removal asks first in a
 * dialog (the focus moves to it; Escape says no): for this app what goes and what stays because other apps use it, for all the apps
 * it affects. Then a result line. The texts, the checks and the buttons' state are the view model's. Parity with `@fadenstack/ui-vue`'s
 * `MyDataSettings`.
 */
export function MyDataSettings(props: MyDataSettingsProps): ReactElement {
  const vm = useViewModel(props.settings);
  const s = vm.strings;
  const id = useId();
  const column = useRef<HTMLDivElement>(null);
  useFirstFocus(column, [props.settings, vm.phase]);
  // The record of tool calls grows as the agents work: read it each time the control is shown.
  useEffect(() => (column.current ? whenShown(column.current, () => { void props.settings.refresh(); }) : undefined), [props.settings]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && vm.showConfirm) {
      e.preventDefault();
      e.stopPropagation();
      vm.cancel();
    }
  };

  return (
    <Shell s={s} theme={props.theme} className={props.className} busy={vm.isBusy} onKeyDown={onKeyDown} columnRef={column}>
      <Title>{s.myDataTitle}</Title>
      <p className="fdn-wizard-note" dir="auto">{s.myDataIntro}</p>
      {vm.showConfirm ? (
        <div className="fdn-card fdn-skills-ask" role="alertdialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}>
          <h3 id={`${id}-title`} dir="auto">{vm.confirmTitle}</h3>
          <div id={`${id}-text`}>
            {vm.confirmLines.map((line, i) => <p key={i} dir="auto">{line}</p>)}
          </div>
          <Actions>
            <Button onClick={() => vm.cancel()} focus label={s.myDataCancelName}>{s.myDataCancel}</Button>
            <Button primary onClick={() => { void vm.confirm(); }} label={vm.confirmName}>{vm.confirmLabel}</Button>
          </Actions>
        </div>
      ) : (
        <>
          <Actions>
            <Button focus disabled={!vm.canAct} onClick={() => { void vm.exportThisApp(); }} label={s.myDataExportName}>{s.myDataExport}</Button>
            <Button disabled={!vm.canAct} onClick={() => { void vm.askRemoveThisApp(); }} label={s.myDataRemoveName}>{s.myDataRemove}</Button>
          </Actions>
          <Actions>
            <Button quiet disabled={!vm.canAct} onClick={() => { void vm.exportAll(); }} label={s.myDataExportAllName}>{s.myDataExportAll}</Button>
            <Button quiet disabled={!vm.canAct} onClick={() => { void vm.askRemoveAll(); }} label={s.myDataRemoveAllName}>{s.myDataRemoveAll}</Button>
          </Actions>
          {vm.hasAudit ? (
            <>
              {/* The person's record of tool calls: how many entries since when, intact or damaged; and its export as a web page. */}
              {vm.hasAuditLine ? (
                <p className={vm.auditDamaged ? "fdn-skills-message fdn-skills-message-warning" : "fdn-skills-message"} data-audit-line dir="auto">{vm.auditLine}</p>
              ) : null}
              <Actions>
                <Button disabled={!vm.canAct} onClick={() => { void vm.exportAudit(); }} label={s.myDataAuditExportName}>{s.myDataAuditExport}</Button>
              </Actions>
            </>
          ) : null}
        </>
      )}
      <p className="fdn-skills-message" role={vm.isError ? "alert" : "status"} dir="auto">{vm.statusText}</p>
    </Shell>
  );
}
