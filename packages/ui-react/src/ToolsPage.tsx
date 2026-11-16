import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import { LocalToolClass, LocalToolRaise } from "@fadenstack/agents";
import {
  ImportSheetViewModel,
  ServerSheetViewModel,
  WebSearchSettingsViewModel,
  type CloudGroupViewModel,
  type LocalServerViewModel,
  type LocalToolViewModel,
  type SecretRowViewModel,
  type ServerDetailsViewModel,
  type ToolsPageViewModel,
  type UiStrings,
} from "@fadenstack/ui";

import { Icon, Spinner } from "./icons.js";
import { useViewModel } from "./hooks.js";
import { WebSearchSheet } from "./WebSearchSettings.js";
import { Actions, Alert, Button, Field, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface ToolsPageProps extends SkillViewProps {
  /** The page's view model; the app calls `open()` when it shows it (and `retext()` when the language changes). */
  tools: ToolsPageViewModel;
}

/**
 * The Tools view (sdk/51 F05) in the wizard's column: a header, the policy, the tabs "On this computer" and "On your server", a filter
 * and Add; the person's MCP servers as cards (a card's name opens its details, with the trust mark, each tool's class and the
 * plain-http switch under Advanced); the add and edit sheet and the paste-import sheet in place of the list; the organisation's tools
 * by server, read only. A header value is a password box that is cleared when the sheet is saved or closed; a saved one shows as dots
 * and Replace. Turning the plain-http switch on opens a warning that takes the focus on its Confirm. Esc closes the top layer.
 * Every command is called in the event's own turn.
 */
export function ToolsPage(props: ToolsPageProps): ReactElement {
  const vm = useViewModel(props.tools);
  const s = vm.strings;
  const column = useRef<HTMLDivElement>(null);
  const sheet = vm.sheet;
  const details = vm.details;
  // A new layer takes the focus: its first marked field, else its title.
  useFirstFocus(column, [sheet, details], true);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!vm.closeTop()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Shell s={s} theme={props.theme} className={`fdn-toolspage${props.className ? ` ${props.className}` : ""}`} busy={vm.isLoadingCloud} onKeyDown={onKeyDown} columnRef={column}>
      {sheet instanceof ServerSheetViewModel ? <ServerSheet sheet={sheet} />
        : sheet instanceof ImportSheetViewModel ? <ImportSheet sheet={sheet} />
          : sheet instanceof WebSearchSettingsViewModel ? <WebSearchSheet sheet={sheet} />
          : details ? <Details details={details} />
            : <Main vm={vm} s={s} />}
    </Shell>
  );
}

function Main({ vm, s }: { vm: ToolsPageViewModel; s: UiStrings }): ReactElement {
  const id = useId();
  const tabKeys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = vm.tabs;
    const step = (e.key === "ArrowLeft") !== (s.direction === "rtl") ? -1 : 1;
    const to = tabs[Math.min(tabs.length - 1, Math.max(0, tabs.indexOf(vm.tab) + step))]!;
    vm.selectTab(to);
    e.preventDefault();
    requestAnimationFrame(() => document.getElementById(`${id}-${to}-tab`)?.focus());
  };
  return (
    <>
      <Title>{s.toolsTitle}</Title>
      <p className="fdn-muted" dir="auto">{s.toolsIntro}</p>
      {vm.needsSignIn && <p className="fdn-wizard-note" role="status" dir="auto">{s.toolsSignInNeeded}</p>}
      {vm.showsLists && (
        <>
          {vm.showsBanner && <p className="fdn-wizard-note" role="status" dir="auto">{vm.bannerText}</p>}
          <div className="fdn-tp-bar">
            <div className="fdn-tp-tabs" role="tablist" aria-label={s.toolsTitle} onKeyDown={tabKeys}>
              <button type="button" role="tab" id={`${id}-app-tab`} className="fdn-tp-tab" aria-selected={vm.showsApp} aria-controls={`${id}-app`}
                tabIndex={vm.showsApp ? 0 : -1} onClick={() => vm.selectTab("app")} dir="auto">{vm.appTabText}</button>
              <button type="button" role="tab" id={`${id}-computer-tab`} className="fdn-tp-tab" aria-selected={vm.showsLocal} aria-controls={`${id}-computer`}
                tabIndex={vm.showsLocal ? 0 : -1} onClick={() => vm.selectTab("computer")} dir="auto">{vm.localTabText}</button>
              {vm.showsServerTab && (
                <button type="button" role="tab" id={`${id}-server-tab`} className="fdn-tp-tab" aria-selected={vm.showsServer} aria-controls={`${id}-server`}
                  tabIndex={vm.showsServer ? 0 : -1} onClick={() => vm.selectTab("server")} dir="auto">{vm.serverTabText}</button>
              )}
            </div>
            {vm.showsLocalChip && (
              <span className={`fdn-badge fdn-tp-policy${vm.policyIsWarning ? " fdn-tp-policy-warning" : ""}`} title={vm.policyTip} dir="auto">
                <Icon name={vm.policyIsWarning ? "warning" : "check"} size={12} />{vm.policyText}
              </span>
            )}
          </div>
          <div className="fdn-wizard-field fdn-tp-filter">
            <input type="text" aria-label={s.toolsFilterPlaceholder} placeholder={s.toolsFilterPlaceholder} autoComplete="off" value={vm.filter}
              onChange={(e) => { vm.filter = e.target.value; }} dir="auto" />
          </div>
          {vm.showsApp
            ? <AppPanel vm={vm} panelId={`${id}-app`} tabId={`${id}-app-tab`} />
            : vm.showsLocal
              ? <LocalPanel vm={vm} s={s} panelId={`${id}-computer`} tabId={`${id}-computer-tab`} />
              : <ServerPanel vm={vm} s={s} panelId={`${id}-server`} tabId={`${id}-server-tab`} />}
        </>
      )}
    </>
  );
}

function AppPanel({ vm, panelId, tabId }: { vm: ToolsPageViewModel; panelId: string; tabId: string }): ReactElement {
  return (
    <div className="fdn-tp-section" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      {vm.showsAppEmpty && <p className="fdn-muted" role="status" dir="auto">{vm.appEmptyText}</p>}
      {vm.showsAppNoMatch && <p className="fdn-muted" role="status" dir="auto">{vm.appNoMatchText}</p>}
      {vm.hasWebSearch && (
        <section className="fdn-card" aria-label={vm.webSearchName}>
          <ul className="fdn-tp-cloud-list">
            <li className="fdn-tp-cloud-tool">
              <div>
                <div className="fdn-tp-name" dir="auto">{vm.webSearchName}</div>
                <div className="fdn-muted" dir="auto">{vm.webSearchText}</div>
              </div>
              <span className="fdn-badge" dir="auto">{vm.webSearchState}</span>
              <Button label={`${vm.webSearchButtonText}: ${vm.webSearchName}`} onClick={() => vm.openWebSearch()}>{vm.webSearchButtonText}</Button>
            </li>
          </ul>
        </section>
      )}
      {vm.appTools.length > 0 && (
        <section className="fdn-card">
          <ul className="fdn-tp-cloud-list">
            {vm.appTools.map((t) => (
              <li key={t.name} className="fdn-tp-cloud-tool">
                <div>
                  <div className="fdn-tp-name" dir="auto">{t.name}</div>
                  {t.hasDescription && <div className="fdn-muted" dir="auto">{t.description}</div>}
                </div>
                <span className={`fdn-badge fdn-class-${t.toolClass}`} dir="auto">{t.classLabel}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LocalPanel({ vm, s, panelId, tabId }: { vm: ToolsPageViewModel; s: UiStrings; panelId: string; tabId: string }): ReactElement {
  return (
    <div className="fdn-tp-section" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      <h3 dir="auto">{s.toolsSectionServers}</h3>
      <p className="fdn-muted" dir="auto">{s.toolsSectionServersHelp}</p>
      {vm.hasListNote && <p className="fdn-wizard-note" role="status" dir="auto">{vm.listNote}</p>}
      <Actions>
        <Button primary onClick={() => vm.addServer()}><Icon name="plus" size={14} /> {s.toolsAddServer}</Button>
        <Button quiet onClick={() => vm.importServers()}>{s.toolsPasteMore}</Button>
      </Actions>
      {vm.showsEmpty && (
        <div className="fdn-card fdn-tp-empty">
          <h3 dir="auto">{s.toolsEmptyTitle}</h3>
          <p dir="auto">{s.toolsEmptyText}</p>
        </div>
      )}
      {vm.showsNoMatch && <p className="fdn-muted" role="status" dir="auto">{s.toolsNoToolsMatch}</p>}
      {vm.servers.length > 0 && (
        <ul className="fdn-skills-list">
          {vm.servers.map((server) => <ServerCard key={server.label} server={server} />)}
        </ul>
      )}
    </div>
  );
}

function ServerCard({ server: model }: { server: LocalServerViewModel }): ReactElement {
  const server = useViewModel(model);
  const s = server.strings;
  return (
    <li className="fdn-card fdn-tp-card" data-selected={server.isSelected ? "" : undefined}>
      <div className="fdn-tp-card-head">
        <span className="fdn-tp-tile"><Icon name="extension" size={16} /></span>
        <button type="button" className="fdn-tp-open" aria-label={server.openName} onClick={() => server.open()}>
          <span className="fdn-skills-name" dir="auto">{server.label}</span>
          <span className="fdn-tp-where" dir="auto" title={server.originText}>{server.originText}</span>
        </button>
        <label className="fdn-skills-switch">
          <input type="checkbox" role="switch" checked={server.isOn} aria-label={server.switchName} onChange={(e) => { server.isOn = e.target.checked; }} />
          <span>{server.isOn ? s.skillOn : s.skillOff}</span>
        </label>
      </div>
      <p className="fdn-tp-status" data-kind={server.statusKind} title={server.statusTip || undefined} dir="auto">
        <span className="fdn-tp-dot" aria-hidden="true" /><span>{server.statusText}</span>
      </p>
      {server.hasChips && (
        <ul className="fdn-tp-chips">
          {server.chips.map((chip, i) => (
            <li key={i} className={`fdn-tp-chip${chip.mayDelete ? " fdn-tp-chip-warn" : ""}${chip.isMore ? " fdn-tp-chip-more" : ""}`} title={chip.tip}
              aria-label={chip.mayDelete ? chip.tip : undefined}>{chip.name}</li>
          ))}
        </ul>
      )}
      {server.hasFix && <Actions><Button quiet onClick={() => server.fix()}>{server.fixText}</Button></Actions>}
    </li>
  );
}

function ServerPanel({ vm, s, panelId, tabId }: { vm: ToolsPageViewModel; s: UiStrings; panelId: string; tabId: string }): ReactElement {
  return (
    <div className="fdn-tp-section" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      <p className="fdn-muted" dir="auto">{s.toolsCloudIntro}</p>
      {vm.isLoadingCloud && <p className="fdn-wizard-busy" role="status" dir="auto"><Spinner /><span>{s.toolsLoading}</span></p>}
      {vm.hasCloudMessage && <p className="fdn-muted" role="status" dir="auto">{vm.cloudMessage}</p>}
      {vm.canRetry && <Actions><Button onClick={() => void vm.retry()}>{s.toolsTryAgain}</Button></Actions>}
      {vm.cloudGroups.map((group) => <CloudGroup key={group.server} group={group} />)}
    </div>
  );
}

function CloudGroup({ group: model }: { group: CloudGroupViewModel }): ReactElement {
  const group = useViewModel(model);
  const id = useId();
  return (
    <section className="fdn-card" aria-labelledby={`${id}-name`}>
      <div className="fdn-tp-group-head">
        <button type="button" className="fdn-tp-group-toggle" aria-expanded={group.isExpanded} aria-controls={`${id}-list`}
          aria-label={group.isExpanded ? group.collapseName : group.expandName} onClick={() => group.toggle()}>
          <Icon name="chevron" size={16} /><span id={`${id}-name`} dir="auto">{group.server}</span>
        </button>
        <span className="fdn-muted" dir="auto">{group.summary}</span>
      </div>
      {group.isExpanded && (
        <ul className="fdn-tp-cloud-list" id={`${id}-list`}>
          {group.tools.map((t) => (
            <li key={t.name} className="fdn-tp-cloud-tool" data-muted={t.isMuted ? "" : undefined} data-off={t.isOff ? "" : undefined}>
              <div>
                <div className="fdn-tp-name" dir="auto">{t.name}</div>
                {t.hasDescription && <div className="fdn-muted" dir="auto">{t.description}</div>}
              </div>
              <span className="fdn-badge" dir="auto">{t.stateText}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Details({ details: model }: { details: ServerDetailsViewModel }): ReactElement {
  const details = useViewModel(model);
  const s = details.strings;
  const id = useId();
  const warning = details.isPlainHttpWarningOpen;
  const asking = details.isConfirmingRemove;
  const root = useRef<HTMLDivElement>(null);
  const wasWarning = useRef(false);
  // The warning's Confirm (or the remove question's Keep) takes the focus; when the warning closes it goes back to the switch it came from.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const returning = wasWarning.current && !warning;
    wasWarning.current = warning;
    if (warning || asking) el.querySelector<HTMLElement>("[data-wizard-focus]")?.focus({ preventScroll: true });
    else if (returning) el.querySelector<HTMLElement>("[data-plain-switch]")?.focus({ preventScroll: true });
  }, [warning, asking]);
  const server = details.server;

  return (
    <div className="fdn-skills-editor" ref={root} aria-busy={details.isBusy}>
      <Title>{details.drawerName}</Title>
      <ServerSwitch server={server} />
      <p className="fdn-tp-status" data-kind={server.statusKind} dir="auto"><span className="fdn-tp-dot" aria-hidden="true" /><span>{details.statusText}</span></p>
      <dl className="fdn-tp-facts">
        {details.facts.map((f) => (
          <div key={f.label}>
            <dt dir="auto">{f.label}</dt>
            <dd className={`${f.isMono ? "fdn-tp-mono" : ""}${f.isMuted ? " fdn-tp-muted" : ""}`.trim() || undefined} dir="auto">{f.value}</dd>
          </div>
        ))}
      </dl>

      <label className="fdn-skills-switch">
        <input type="checkbox" role="switch" checked={details.isTrusted} disabled={!details.canChangeMarks} aria-label={details.trustedName}
          aria-describedby={`${id}-trusted`} onChange={(e) => { details.isTrusted = e.target.checked; }} />
        <span dir="auto">{s.toolsTrusted}</span>
      </label>
      <p id={`${id}-trusted`} className="fdn-tp-help" dir="auto">{details.trustedNote}</p>
      <p className="fdn-tp-help" dir="auto">{s.toolsDrawerNote}</p>

      <div className="fdn-tp-section">
        <h3 dir="auto">{details.toolsTitle}</h3>
        <div className="fdn-wizard-field fdn-tp-filter">
          <input type="text" aria-label={s.toolsDrawerFilterName} placeholder={s.toolsDrawerFilterPlaceholder} autoComplete="off" value={details.toolFilter}
            onChange={(e) => { details.toolFilter = e.target.value; }} dir="auto" />
        </div>
        {details.hasNoToolsText && <p className="fdn-muted" role="status" dir="auto">{details.noToolsText}</p>}
        <ul className="fdn-tp-toollist">
          {details.tools.map((tool) => <ToolRow key={tool.name} tool={tool} s={s} />)}
        </ul>
      </div>

      {details.showsAdvanced && (
        <div className="fdn-tp-section">
          <h3 dir="auto">{s.toolsAdvanced}</h3>
          <label className="fdn-skills-switch">
            <input type="checkbox" role="switch" data-plain-switch="" checked={details.plainHttpOn} aria-describedby={`${id}-plain`}
              onChange={(e) => { details.plainHttpOn = e.target.checked; }} />
            <span dir="auto">{s.mcpPlainHttpSwitch}</span>
          </label>
          <p id={`${id}-plain`} className="fdn-tp-help" dir="auto">{s.mcpPlainHttpSwitchHelp}</p>
          {details.hasPlainHttpError && <Alert>{details.plainHttpError}</Alert>}
          {warning && (
            <div className="fdn-card fdn-tp-warning" role="alertdialog" aria-labelledby={`${id}-warn-title`} aria-describedby={`${id}-warn-text`}>
              <h3 id={`${id}-warn-title`} dir="auto">{s.mcpPlainHttpWarningTitle}</h3>
              <p id={`${id}-warn-text`} dir="auto">{details.plainHttpWarningText}</p>
              <Actions>
                <Button primary focus onClick={() => void details.confirmPlainHttp()}>{s.mcpPlainHttpConfirm}</Button>
                <Button onClick={() => details.cancelPlainHttp()}>{s.mcpPlainHttpCancel}</Button>
              </Actions>
            </div>
          )}
        </div>
      )}

      {details.hasTest && <p className="fdn-tp-result" role="status" dir="auto">{details.testText}</p>}
      {details.isConfirmingRemove ? (
        <div className="fdn-card fdn-skills-ask" role="group" aria-labelledby={`${id}-remove`}>
          <h3 id={`${id}-remove`} role="alert" dir="auto">{details.removeConfirmText}</h3>
          <Actions>
            <Button focus onClick={() => details.keep()}>{s.toolsRemoveKeep}</Button>
            <Button primary label={details.removeName} onClick={() => void details.confirmRemove()}>{s.toolsRemoveYes}</Button>
          </Actions>
        </div>
      ) : (
        <Actions>
          <Button disabled={details.isBusy} onClick={() => void details.test()}>{s.toolsTestTooltip}</Button>
          <Button disabled={!details.canRestart} onClick={() => void details.restart()}>{s.toolsRestartTooltip}</Button>
          <Button onClick={() => details.edit()}>{s.toolsEditTooltip}</Button>
          <Button quiet onClick={() => details.askRemove()}>{s.toolsRemoveTooltip}</Button>
        </Actions>
      )}
      <Actions><Button quiet onClick={() => details.close()}>{s.toolsCloseDetails}</Button></Actions>
    </div>
  );
}

function ServerSwitch({ server: model }: { server: LocalServerViewModel }): ReactElement {
  const server = useViewModel(model);
  const s = server.strings;
  return (
    <label className="fdn-skills-switch">
      <input type="checkbox" role="switch" checked={server.isOn} aria-label={server.switchName} onChange={(e) => { server.isOn = e.target.checked; }} />
      <span>{server.isOn ? s.skillOn : s.skillOff}</span>
    </label>
  );
}

function ToolRow({ tool: model, s }: { tool: LocalToolViewModel; s: UiStrings }): ReactElement {
  const tool = useViewModel(model);
  const id = useId();
  const classCss = tool.class === LocalToolClass.Write ? " fdn-class-write" : tool.isDestructive ? " fdn-class-destructive" : "";
  return (
    <li className="fdn-card fdn-tp-tool">
      <div className="fdn-tp-name" dir="auto">{tool.name}</div>
      {tool.hasDescription && <div className="fdn-muted" dir="auto">{tool.description}</div>}
      <div className="fdn-skills-badges">
        {tool.hints.map((hint) => <span key={hint} className="fdn-badge" dir="auto">{hint}</span>)}
        <span className={`fdn-badge${classCss}`} dir="auto">{tool.classText}</span>
      </div>
      {tool.isDestructive && <p className="fdn-tp-help" dir="auto">{tool.destructiveHelp}</p>}
      {!tool.isDestructive && (
        <div className="fdn-tp-tool-picker">
          <label htmlFor={`${id}-raise`} dir="auto">{s.toolsRaiseLabel}</label>
          <select id={`${id}-raise`} aria-label={tool.raiseName} value={tool.selectedRaise} disabled={!tool.canRaise}
            onChange={(e) => { tool.selectedRaise = e.target.value as LocalToolRaise; }}>
            {tool.raiseOptions.map((o) => <option key={o.raise} value={o.raise}>{o.text}</option>)}
          </select>
        </div>
      )}
    </li>
  );
}

function ServerSheet({ sheet: model }: { sheet: ServerSheetViewModel }): ReactElement {
  const sheet = useViewModel(model);
  const s = sheet.strings;
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void sheet.save();
  };
  return (
    <form className="fdn-tp-sheet" onSubmit={submit} noValidate aria-busy={sheet.isBusy}>
      <Title>{sheet.title}</Title>
      <Field id={`${id}-label`} label={s.toolsFieldLabel}>
        <input id={`${id}-label`} type="text" autoComplete="off" spellCheck={false} dir="ltr" value={sheet.label} aria-describedby={`${id}-label-help`}
          data-wizard-focus="" onChange={(e) => { sheet.label = e.target.value; }} />
      </Field>
      <p id={`${id}-label-help`} className="fdn-tp-help" dir="auto">{s.toolsFieldLabelHelp}</p>
      <Field id={`${id}-url`} label={s.toolsFieldUrl}>
        <input id={`${id}-url`} type="text" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr" value={sheet.url} aria-describedby={`${id}-url-help`}
          onChange={(e) => { sheet.url = e.target.value; }} />
      </Field>
      <p id={`${id}-url-help`} className="fdn-tp-help" dir="auto">{s.toolsFieldUrlHelp}</p>

      <fieldset>
        <legend dir="auto">{s.toolsFieldHeaders}</legend>
        {sheet.headerRows.map((row, i) => <HeaderRow key={i} row={row} s={s} />)}
        <Actions><Button quiet onClick={() => sheet.addHeader()}>{s.toolsAddRow}</Button></Actions>
        <p className="fdn-tp-help" dir="auto">{s.toolsSecretsNote}</p>
      </fieldset>

      <Field id={`${id}-timeout`} label={s.toolsFieldTimeout}>
        <input id={`${id}-timeout`} type="number" inputMode="numeric" min={5} max={600} value={sheet.timeoutText} onChange={(e) => { sheet.timeoutText = e.target.value; }} />
      </Field>
      <div className="fdn-wizard-check">
        <input id={`${id}-enabled`} type="checkbox" checked={sheet.enabled} onChange={(e) => { sheet.enabled = e.target.checked; }} />
        <label htmlFor={`${id}-enabled`} dir="auto">{s.toolsFieldEnabled}</label>
      </div>

      {sheet.hasError && <Alert>{sheet.errorText}</Alert>}
      {sheet.hasTest && <p className="fdn-tp-result" role="status" dir="auto">{sheet.testText}</p>}
      <Actions>
        <Button primary submit disabled={sheet.isBusy}>{sheet.primaryText}</Button>
        <Button disabled={sheet.isBusy} onClick={() => void sheet.test()}>{s.toolsTestButton}</Button>
        <Button onClick={() => sheet.cancel()}>{s.toolsCancel}</Button>
      </Actions>
      {sheet.isAdding && <Actions><Button quiet onClick={() => sheet.importMore()}>{s.toolsPasteMore}</Button></Actions>}
    </form>
  );
}

function HeaderRow({ row: model, s }: { row: SecretRowViewModel; s: UiStrings }): ReactElement {
  const row = useViewModel(model);
  return (
    <div className="fdn-tp-row">
      <input type="text" aria-label={`${s.toolsRowName} (${s.toolsFieldHeaders})`} autoComplete="off" spellCheck={false} dir="ltr" value={row.name} onChange={(e) => { row.name = e.target.value; }} />
      {row.isKept ? (
        <>
          <span className="fdn-tp-dots" role="img" aria-label={row.savedName}>{s.toolsValueSaved}</span>
          <Button quiet label={`${s.toolsReplaceValue} ${row.name}`} onClick={() => row.replace()}>{s.toolsReplaceValue}</Button>
        </>
      ) : (
        <input type="password" aria-label={`${s.toolsRowValue} ${row.name}`.trim()} autoComplete="new-password" spellCheck={false} dir="ltr" value={row.value}
          onChange={(e) => { row.value = e.target.value; }} />
      )}
      <Button quiet label={`${s.toolsRemoveRow} ${row.name}`.trim()} onClick={() => row.remove()}><Icon name="close" size={14} /></Button>
    </div>
  );
}

function ImportSheet({ sheet: model }: { sheet: ImportSheetViewModel }): ReactElement {
  const sheet = useViewModel(model);
  const s = sheet.strings;
  const id = useId();
  return (
    <div className="fdn-tp-sheet" aria-busy={sheet.isBusy}>
      <Title>{s.toolsImportTitle}</Title>
      <p dir="auto">{s.toolsPasteIntro}</p>
      <Field id={`${id}-text`} label={s.toolsPasteField}>
        <textarea id={`${id}-text`} rows={6} autoComplete="off" spellCheck={false} dir="ltr" value={sheet.text} data-wizard-focus=""
          onChange={(e) => { sheet.text = e.target.value; }} />
      </Field>
      <Actions><Button disabled={!sheet.canRead} onClick={() => void sheet.read()}>{s.toolsPasteRead}</Button></Actions>
      {sheet.hasStatus && (sheet.statusIsProblem ? <Alert>{sheet.statusText}</Alert> : <p className="fdn-tp-result" role="status" dir="auto">{sheet.statusText}</p>)}
      {sheet.candidates.length > 0 && (
        <ul className="fdn-tp-toollist">
          {sheet.candidates.map((c) => <ImportRow key={c.label} row={c} />)}
        </ul>
      )}
      {sheet.hasSkipped && (
        <div className="fdn-tp-section">
          <h3 dir="auto">{s.toolsSkippedTitle}</h3>
          <ul className="fdn-tp-toollist">
            {sheet.skipped.map((k, i) => (
              <li key={i} className="fdn-card fdn-tp-tool">
                <div className="fdn-tp-name" dir="auto">{k.name}</div>
                <div className="fdn-muted" dir="auto">{k.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sheet.hasResult && <p className="fdn-tp-result" role="status" dir="auto">{sheet.resultText}</p>}
      <Actions>
        <Button primary disabled={!sheet.canImport} onClick={() => void sheet.importSelected()}>{s.toolsImportButton}</Button>
        <Button onClick={() => sheet.cancel()}>{s.toolsCancel}</Button>
      </Actions>
    </div>
  );
}

function ImportRow({ row: model }: { row: ImportSheetViewModel["candidates"][number] }): ReactElement {
  const row = useViewModel(model);
  return (
    <li className="fdn-card fdn-tp-tool">
      <label className="fdn-wizard-check">
        <input type="checkbox" checked={row.isTicked} aria-label={row.tickName} onChange={(e) => { row.isTicked = e.target.checked; }} />
        <span className="fdn-tp-name" dir="auto">{row.label}</span>
      </label>
      <div className="fdn-muted fdn-tp-where" dir="auto">{row.where}</div>
      {row.notes.map((n, i) => <p key={i} className="fdn-tp-help" dir="auto">{n}</p>)}
    </li>
  );
}
