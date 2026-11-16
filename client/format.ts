import { ReasonCodeSchema, type ReasonCode } from "../shared/schema";

/** Locale-aware date formatting; falls back to ISO text where Intl is unavailable. */
export function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16);
  }
}

export function formatTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/** Compact relative age such as "5m", "3h", "2d"; dates older than a week use the short date. */
export function formatAge(iso: string | null, locale: string, now = Date.now()): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  try {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    if (seconds < 60) return relative.format(-seconds, "second");
    if (seconds < 3600) return relative.format(-Math.round(seconds / 60), "minute");
    if (seconds < 86_400) return relative.format(-Math.round(seconds / 3600), "hour");
    if (seconds < 7 * 86_400) return relative.format(-Math.round(seconds / 86_400), "day");
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}

/** Finds a known reason code in an RPC error, so the message can be translated. */
export function reasonFromError(error: unknown): ReasonCode | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const code of ReasonCodeSchema.options) {
    if (new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`).test(message)) return code;
  }
  return null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
