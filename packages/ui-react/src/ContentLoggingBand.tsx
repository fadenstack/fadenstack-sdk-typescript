import type { ReactElement } from "react";

import type { ContentLoggingBandViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/**
 * The band in the chat while content logging is on (8.1): until when, what is written to the logs, and Stop. Nothing while it is off. The
 * texts are the view model's. Parity with `@fadenstack/ui-vue`'s `ContentLoggingBand`; .NET: the band in `ChatView` in both skins.
 */
export function ContentLoggingBand({ band }: { band: ContentLoggingBandViewModel }): ReactElement | null {
  useViewModel(band);
  if (!band.isShown) return null;
  return (
    <div className="fdn-grant-marker fdn-content-logging-band" role="status">
      <Icon name="warning" size={14} />
      <span className="fdn-grant-marker-text">{band.text}</span>
      <button type="button" className="fdn-button fdn-quiet" aria-label={band.stopName} onClick={() => band.stop()}>{band.stopText}</button>
    </div>
  );
}
