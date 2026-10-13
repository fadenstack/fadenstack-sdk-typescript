/** The panel's icons, inline (no icon library): 16 px, `currentColor`. The paths are @fadenstack/ui-web's. */
import type { ReactElement } from "react";

import { iconPaths, type IconName } from "@fadenstack/ui-web";

export type { IconName };

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }): ReactElement {
  return (
    <svg
      className="fdn-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

/** The round "working" indicator. */
export function Spinner({ size = 14 }: { size?: number }): ReactElement {
  return <span className="fdn-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
