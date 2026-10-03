/** The panel's icons, inline (no icon library): 16 px, `currentColor`. */
import type { ReactElement } from "react";

const paths = {
  send: "M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z",
  stop: "M7 7h10v10H7z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  history: "M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z",
  chevron: "M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z",
  copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z",
  check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
  close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
  tool: "M22.7 19 13.6 9.9c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z",
  warning: "M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z",
  shield: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11z",
  info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z",
  retry: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z",
  trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
  sparkle: "M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z",
  page: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm4 18H6V4h7v5h5z",
  brain: "M12 3a4 4 0 0 0-4 4v.1A3.5 3.5 0 0 0 5 10.5c0 .9.3 1.7.9 2.4A3.5 3.5 0 0 0 8 19h.2A4 4 0 0 0 16 19h.2a3.5 3.5 0 0 0 2-6.1c.5-.7.8-1.5.8-2.4A3.5 3.5 0 0 0 16 7.1V7a4 4 0 0 0-4-4zm-1 3v12H9a1.5 1.5 0 0 1 0-3V9A1.5 1.5 0 0 1 11 6zm2 0a1.5 1.5 0 0 1 2 3v6a1.5 1.5 0 0 1 0 3h-2z",
  book: "M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 4h5v8l-2.5-1.5L6 12z",
} as const;

export type IconName = keyof typeof paths;

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
      <path d={paths[name]} />
    </svg>
  );
}

/** The round "working" indicator. */
export function Spinner({ size = 14 }: { size?: number }): ReactElement {
  return <span className="fdn-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
