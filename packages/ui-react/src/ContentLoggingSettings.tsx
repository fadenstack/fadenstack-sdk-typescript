import { useId, useRef, type ReactElement } from "react";

import type { ContentLoggingSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Actions, Button, Field, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface ContentLoggingSettingsProps extends SkillViewProps {
  /** The setting's view model (`new ContentLoggingSettingsViewModel({ agent })`). Call its `dispose()` when the page goes. */
  settings: ContentLoggingSettingsViewModel;
}

/**
 * The setting for content logging, where an app keeps its settings (8.1): only where the app offers it and the machine policy allows it, a
 * choice of 1 hour, 4 hours or 24 hours, Start and Stop, the end time while it is on, and what is logged. The texts are the view model's;
 * the buttons and their state are too. Parity with `@fadenstack/ui-vue`'s `ContentLoggingSettings`; .NET: `ContentLoggingSettingsView`
 * in both skins.
 */
export function ContentLoggingSettings(props: ContentLoggingSettingsProps): ReactElement | null {
  const vm = useViewModel(props.settings);
  const s = vm.strings;
  const id = useId();
  const column = useRef<HTMLDivElement>(null);
  useFirstFocus(column, [props.settings], vm.isAvailable);
  if (!vm.isAvailable) return null;

  return (
    <Shell s={s} theme={props.theme} className={props.className} busy={false} columnRef={column}>
      <Title>{s.contentLoggingTitle}</Title>
      <p className="fdn-wizard-note" dir="auto">{vm.introText}</p>
      <form className="fdn-wizard-form" onSubmit={(e) => { e.preventDefault(); vm.start(); }} noValidate>
        <Field id={`${id}-duration`} label={s.contentLoggingDuration}>
          <select id={`${id}-duration`} value={vm.selectedIndex} disabled={!vm.canStart} data-wizard-focus=""
            onChange={(e) => { vm.selectedIndex = Number(e.target.value); }}>
            {vm.choices.map((choice, index) => <option key={choice.durationMs} value={index}>{choice.text}</option>)}
          </select>
        </Field>
        <Actions>
          <Button primary submit disabled={!vm.canStart} label={s.contentLoggingStartName}>{s.contentLoggingStart}</Button>
          <Button onClick={() => vm.stop()} disabled={!vm.canStop} label={s.contentLoggingStopName}>{s.markerStop}</Button>
        </Actions>
        <p className="fdn-skills-message" role="status" dir="auto">{vm.onUntilText}</p>
      </form>
    </Shell>
  );
}
