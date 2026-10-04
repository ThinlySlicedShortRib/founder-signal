import type { DeliveryPreset } from "@fs/schema";

/** What each "Send it ___" choice means. Weekdays: 0 = Sunday … 6 = Saturday. */
export const DELIVERY_PRESETS: Record<DeliveryPreset, { weekdays: number[]; localTime: string }> = {
  weekday_mornings: { weekdays: [1, 2, 3, 4, 5], localTime: "07:30" },
  lunch: { weekdays: [0, 1, 2, 3, 4, 5, 6], localTime: "12:00" },
  sunday_mornings: { weekdays: [0], localTime: "09:00" },
  evenings: { weekdays: [0, 1, 2, 3, 4, 5, 6], localTime: "18:00" },
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock reading of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string): WallClock {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return { year: +parts.year!, month: +parts.month!, day: +parts.day!, hour: +parts.hour!, minute: +parts.minute! };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant a local wall-clock time happens in `timeZone`. A time that
 * happens twice (clocks going back) resolves to the first occurrence; a time
 * that doesn't exist (clocks going forward) moves forward past the gap.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(naive - 12 * 3_600_000, timeZone);
  const after = offsetAt(naive + 12 * 3_600_000, timeZone);
  // The larger offset gives the earlier instant, so it's tried first.
  for (const offset of before >= after ? [before, after] : [after, before]) {
    const w = wallClock(naive - offset, timeZone);
    if (w.day === day && w.hour === hour && w.minute === minute) return new Date(naive - offset);
  }
  return new Date(naive - Math.min(before, after));
}

export interface ScheduleRule {
  weekdays: readonly number[];
  /** "HH:MM" */
  localTime: string;
  timeZone: string;
}

/**
 * The next delivery strictly after `now` (build plan §6.1). It's computed in
 * the user's zone, so it stays at the same local time across DST changes.
 * Null when no weekday is chosen.
 */
export function nextRunAt({ weekdays, localTime, timeZone }: ScheduleRule, now: Date): Date | null {
  if (!weekdays.length) return null;
  const [hour, minute] = localTime.split(":").map(Number) as [number, number];
  const today = wallClock(now.getTime(), timeZone);
  // Eight local days: a weekly rule whose time has already passed today recurs in seven.
  for (let i = 0; i < 8; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!weekdays.includes(date.getUTCDay())) continue;
    const run = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (run.getTime() > now.getTime()) return run;
  }
  return null;
}

/** The calendar date ("YYYY-MM-DD") of `instant` in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): string {
  const w = wallClock(instant.getTime(), timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}
