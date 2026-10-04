/** Dates, times and small text helpers for the reading screens. Everything is in the device's local time. */

const pad = (n: number) => String(n).padStart(2, "0");

/** The device's local date as YYYY-MM-DD (events' `localDay`). */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM for /me/activity. */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** A YYYY-MM-DD date read as a local calendar day (not UTC midnight). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** "Monday, October 5" */
export function longDate(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "Mon, Oct 5" */
export function shortDate(day: string | Date): string {
  const d = typeof day === "string" ? parseDay(day) : day;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "7:30" or "18:00": the board's clock, 24-hour so evenings aren't ambiguous. */
export function clock(d: Date): string {
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

/** "Tuesday" */
export function weekday(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

/** "Mon 7:30" */
export function dayAndTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock(d)}`;
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "saved today", "saved Fri", "saved Sep 30" */
export function savedWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((parseDay(localDay(now)).getTime() - parseDay(localDay(d)).getTime()) / 86_400_000);
  if (days <= 0) return "saved today";
  if (days === 1) return "saved yesterday";
  if (days < 7) return `saved ${d.toLocaleDateString("en-US", { weekday: "short" })}`;
  return `saved ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** 252 → "4:12" */
export function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An RFC 4122 v4 UUID for event IDs (the server ignores duplicates, so these only need to be unique). */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** First name for "More about Dana" and "Follow Dana". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
