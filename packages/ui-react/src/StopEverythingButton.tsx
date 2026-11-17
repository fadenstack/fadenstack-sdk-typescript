import type { ReactElement } from "react";

import type { StopEverythingViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";
import type { SkillViewProps } from "./SkillParts.js";

export interface StopEverythingButtonProps extends SkillViewProps {
  /** The control's view model (`new StopEverythingViewModel({ agents: () => [...] })`). */
  stop: StopEverythingViewModel;
}

/**
 * "Stop everything", the emergency stop for an app's tray menu or title bar: an icon button named "Stop everything" with a tooltip, and
 * the line that says what it did. No confirmation. The texts and the stop are the view model's. Parity with `@fadenstack/ui-vue`'s
 * `StopEverythingButton`.
 */
export function StopEverythingButton(props: StopEverythingButtonProps): ReactElement {
  const vm = useViewModel(props.stop);
  const s = vm.strings;
  return (
    <div className={`fdn-chat fdn-stop-everything${props.className ? ` ${props.className}` : ""}`} data-theme={props.theme ?? "system"} lang={s.language} dir={s.direction}>
      <button type="button" className="fdn-icon-button fdn-stop-everything-button" aria-label={vm.name} title={vm.toolTip} disabled={!vm.canStop}
        aria-busy={vm.isBusy} onClick={() => { void vm.stop(); }}>
        <Icon name="stop" size={16} />
      </button>
      {/* The live region is always there and only its text comes and goes, so a screen reader announces the line politely when it
          appears (WCAG 4.1.3 status messages); empty, it takes no room. */}
      <span className="fdn-stop-everything-result" role="status" aria-live="polite" dir="auto">{vm.resultText}</span>
    </div>
  );
}
