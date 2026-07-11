export interface QuietHours {
  enabled: boolean;
  start: number; // minute-of-day 0..1439, local (tz) time
  end: number;   // minute-of-day 0..1439, local (tz) time
  tz: string;    // IANA timezone
}

/** Current minute-of-day (0..1439) in the given IANA timezone; throws RangeError on a bad tz. */
export function minuteOfDayInTz(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

/** True when nowMs is inside the quiet window. Fail-open: disabled, empty
 *  (start===end), or an unparseable tz all return false (not quiet → send). */
export function isWithinQuietHours(qh: QuietHours, nowMs: number): boolean {
  if (!qh.enabled || qh.start === qh.end) return false;
  let m: number;
  try {
    m = minuteOfDayInTz(nowMs, qh.tz);
  } catch {
    return false; // bad tz → don't suppress
  }
  return qh.start < qh.end
    ? m >= qh.start && m < qh.end          // same-day window
    : m >= qh.start || m < qh.end;         // overnight (wraps midnight)
}
