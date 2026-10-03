/** "350 ms", "1.2 s". */
export function formatDuration(ms: number, locale?: string): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

export function formatNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** When a session was last used: the time today, "Yesterday", the weekday this week, else the date. */
export function formatWhen(at: Date, now: Date, yesterday: string, locale?: string): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  if (days === 1) return yesterday;
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at);
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(at);
}

/** Text up to `length` characters, with how much was left out. */
export function preview(text: string | undefined, length: number, more: (count: string) => string, locale?: string): string {
  if (!text) return "";
  return text.length <= length ? text : `${text.slice(0, length)}\n${more(formatNumber(text.length - length, locale))}`;
}
