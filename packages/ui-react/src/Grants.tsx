import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";

import type { BypassPart, GrantMarkerViewModel, GrantPart, GrantsViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/** Takes the focus when the card shows: the button marked `data-fdn-focus` (never Allow), else the card. */
function useFocusOnShow(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const target = card.querySelector<HTMLElement>("[data-fdn-focus]") ?? card;
    target.focus({ preventScroll: false });
  }, []);
  return ref;
}

/** Enter and Escape never press a button of the Bypass card, even a focused one (the click is the only answer). */
const ignoreKeys = (part: BypassPart) => (event: KeyboardEvent) => {
  if (part.ignoresKey(event.key)) event.preventDefault();
};

function Durations({ part }: { part: GrantPart | BypassPart }): ReactElement {
  return (
    <div className="fdn-grant-durations" role="radiogroup" aria-label={part.durationLabel}>
      {part.durations.map((d) => (
        <button key={d.value} type="button" role="radio" aria-checked={d.value === part.selectedDuration} disabled={!part.isPending}
          className={`fdn-button${d.value === part.selectedDuration ? " fdn-selected" : ""}`} onClick={() => part.selectDuration(d.value)}>
          {d.label}
        </button>
      ))}
    </div>
  );
}

/** The grant card: "Work alongside you?", or the extension card with only what it adds. */
export function GrantCardView({ part }: { part: GrantPart }): ReactElement {
  useViewModel(part);
  const ref = useFocusOnShow();
  return (
    <div className="fdn-approval fdn-grant" role="group" aria-label={part.title} ref={ref} tabIndex={-1}>
      <div className="fdn-approval-head">
        <Icon name="shield" />
        <strong>{part.title}</strong>
      </div>
      {part.reason && <p className="fdn-approval-reason" dir="auto">{part.reason}</p>}
      {part.hasPlaces && (
        <div className="fdn-grant-places">
          <div className="fdn-label">{part.placesHeading}</div>
          <ul>
            {part.places.map((place) => (
              <PlaceRow key={place.place.identifier} place={place} part={part} />
            ))}
          </ul>
        </div>
      )}
      <Durations part={part} />
      <p className="fdn-approval-reason">{part.mayText}</p>
      <p className="fdn-approval-reason">{part.stillAsksText}</p>
      {part.isPending ? (
        <div className="fdn-approval-pair fdn-grant-buttons">
          {part.buttons.map((button) => button === "notNow"
            ? <button key={button} type="button" className="fdn-button fdn-quiet" data-fdn-focus="" onClick={() => part.notNow()}>{part.notNowText}</button>
            : <button key={button} type="button" className="fdn-button fdn-primary" disabled={!part.canAllow} onClick={() => part.allow()}>{part.allowText}</button>)}
        </div>
      ) : (
        <div className={`fdn-approval-state fdn-approval-${part.state}`} role="status">{part.stateText}</div>
      )}
    </div>
  );
}

function PlaceRow({ place, part }: { place: GrantPart["places"][number]; part: GrantPart }): ReactElement {
  useViewModel(place);
  return (
    <li className={place.kept ? "fdn-grant-place" : "fdn-grant-place fdn-removed"}>
      <span dir="auto">{place.label}</span>
      {part.isPending && (
        <button type="button" className="fdn-button fdn-quiet" aria-pressed={!place.kept} aria-label={`${place.kept ? part.removeText : part.addBackText} ${place.label}`}
          onClick={() => place.toggle()}>
          {place.kept ? part.removeText : part.addBackText}
        </button>
      )}
    </li>
  );
}

/**
 * The Bypass confirmation: what no longer asks, what still asks, what the server records, how long (shortest first), why.
 * Not now comes first and takes the focus; Allow is never the default, and Enter and Escape never press it.
 */
export function BypassCardView({ part }: { part: BypassPart }): ReactElement | null {
  useViewModel(part);
  const ref = useFocusOnShow();
  if (!part.isShown) return null;
  const keys = ignoreKeys(part);
  return (
    <div className="fdn-approval fdn-bypass fdn-approval-danger" role="group" aria-label={part.title} ref={ref} tabIndex={-1}>
      <div className="fdn-approval-head">
        <Icon name="warning" />
        <strong>{part.title}</strong>
      </div>
      {part.appReason && <p className="fdn-approval-reason" dir="auto">{part.appReason}</p>}
      <p className="fdn-approval-reason">{part.noLongerAsksText}</p>
      <p className="fdn-approval-reason">{part.stillAsksText}</p>
      <p className="fdn-approval-reason">{part.recordsText}</p>
      {part.isPending && (
        <>
          <Durations part={part} />
          <p className="fdn-approval-reason">{part.noExtensionText}</p>
          <label className="fdn-bypass-reason">
            <span className="fdn-label">{part.reasonLabel}</span>
            <input type="text" value={part.reason} maxLength={part.reasonLength} dir="auto" onChange={(e) => { part.reason = e.target.value; }} />
          </label>
          <p className="fdn-approval-reason">{part.reasonSeenText}</p>
          <div className="fdn-approval-pair fdn-grant-buttons">
            {part.buttons.map((button) => button === "notNow"
              ? <button key={button} type="button" className="fdn-button fdn-quiet" data-fdn-focus="" onClick={() => part.notNow()}>{part.notNowText}</button>
              : <button key={button} type="button" className="fdn-button" disabled={!part.canAllow} onKeyDown={keys} onClick={() => part.allow()}>{part.allowText}</button>)}
          </div>
        </>
      )}
      {!part.isPending && <div className="fdn-approval-state" role="status">{part.stateText}</div>}
      {part.isSigningIn && (
        <div className="fdn-bypass-signin">
          {part.signInCodeText && <p className="fdn-approval-reason">{part.signInCodeText}</p>}
          <button type="button" className="fdn-button" aria-label={part.openAgainName} disabled={!part.canOpenAgain} onKeyDown={keys}
            onClick={() => part.openAgain()}>{part.openAgainText}</button>
        </div>
      )}
      {part.canClose && <button type="button" className="fdn-button fdn-quiet" onClick={() => part.close()}>{part.closeText}</button>}
    </div>
  );
}

/**
 * Everything of the chat's grants above the composer: the cards waiting for the person, the Bypass confirmation, the
 * running-grant marker with Stop and "Another 30 min", the Bypass marker with Stop, and the line that says Bypass ended.
 */
export function GrantsBar({ grants, strings }: { grants: GrantsViewModel; strings: UiStrings }): ReactElement | null {
  useViewModel(grants);
  const card = grants.bypassCard;
  const open = grants.cards;
  if (open.length === 0 && !card && !grants.hasMarker && !grants.hasBypass && !grants.hasBypassEnded && !grants.message) return null;
  return (
    <div className="fdn-grants">
      {open.map((part) => <GrantCardView key={part.key} part={part} />)}
      {card && <BypassCardView part={card} />}
      {grants.hasMarker && (
        <div className="fdn-grant-marker" role="status">
          <Icon name="shield" size={14} />
          <span className="fdn-grant-marker-text">{grants.markerText}</span>
          {grants.isEnding && <button type="button" className="fdn-button" onClick={() => void grants.keepGoing()}>{grants.keepGoingText}</button>}
          <button type="button" className="fdn-button fdn-quiet" onClick={() => void grants.stop()}>{grants.stopText}</button>
        </div>
      )}
      {grants.hasBypass && (
        <div className="fdn-grant-marker fdn-bypass-marker" role="status">
          <Icon name="warning" size={14} />
          <span className="fdn-grant-marker-text">{grants.bypassText}</span>
          <span className="fdn-muted">{grants.bypassRecordedText}</span>
          <button type="button" className="fdn-button fdn-quiet" aria-label={grants.bypassStopName} onClick={() => void grants.stopBypass()}>{strings.markerStop}</button>
        </div>
      )}
      {grants.hasBypassEnded && (
        <div className="fdn-grant-marker fdn-bypass-ended" role="status">
          <span className="fdn-grant-marker-text">{grants.bypassEndedText}</span>
          {grants.canSwitchOnAgain && (
            <button type="button" className="fdn-button" aria-label={grants.switchOnAgainName} onClick={() => void grants.switchOnAgain()}>{grants.switchOnAgainText}</button>
          )}
          <button type="button" className="fdn-icon-button fdn-small" aria-label={grants.closeText} title={grants.closeText} onClick={() => grants.dismissBypassEnded()}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {grants.message && <div className="fdn-banner" role="alert">{grants.message}</div>}
    </div>
  );
}

/** Settings -> Approvals: the grants the server holds and what was allowed always, each with Revoke. */
export function ApprovalsSection({ grants }: { grants: GrantsViewModel }): ReactElement {
  useViewModel(grants);
  return (
    <div role="group" aria-label={grants.standingTitle} className="fdn-menu-extra">
      <div className="fdn-menu-heading">{grants.standingTitle}</div>
      {!grants.hasStanding && <div className="fdn-menu-note">{grants.standingEmpty}</div>}
      {grants.standing.map((item, index) => (
        <div key={index} className={`fdn-standing${item.isBypass ? " fdn-standing-bypass" : ""}`}>
          <span className="fdn-standing-title" dir="auto">{item.title}</span>
          <button type="button" className="fdn-button fdn-quiet" aria-label={`${grants.revokeText} ${item.title}`} onClick={() => void item.revoke()}>
            {grants.revokeText}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The marker for every grant of the device, across chats, for a host to show outside the chat (a title bar, a tray):
 * the time left by the server's clock, Stop, "Another 30 min" near the end, and one summary per grant that ended.
 */
export function GrantMarkerView({ marker }: { marker: GrantMarkerViewModel }): ReactElement | null {
  useViewModel(marker);
  if (!marker.isOn && marker.summaries.length === 0 && !marker.hasMessage) return null;
  return (
    <div className="fdn-grants fdn-device-marker">
      {marker.isOn && (
        <div className="fdn-grant-marker" role="status">
          <Icon name="shield" size={14} />
          <span className="fdn-grant-marker-text">{marker.markerText}</span>
          {marker.isEnding && <button type="button" className="fdn-button" onClick={() => void marker.keepGoing()}>{marker.keepGoingText}</button>}
          <button type="button" className="fdn-button fdn-quiet" onClick={() => void marker.stop()}>{marker.stopText}</button>
        </div>
      )}
      {marker.entries.length > 1 && (
        <ul className="fdn-grant-entries">
          {marker.entries.map((entry) => <li key={entry.grantId} dir="auto">{entry.text}</li>)}
        </ul>
      )}
      {marker.hasMessage && <div className="fdn-banner" role="alert">{marker.message}</div>}
      {marker.summaries.map((summary) => (
        <div key={summary.grantId} className="fdn-grant-summary" role="status">
          <strong>{summary.title}</strong>
          <div className="fdn-grant-summary-detail" dir="auto">{summary.detail}</div>
          <button type="button" className="fdn-icon-button fdn-small" aria-label={marker.dismissText} title={marker.dismissText} onClick={() => marker.dismiss(summary)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
