import type { ActivityMonth } from "@fs/schema";

/**
 * Activity (build plan §6.6). A day's intensity counts the distinct items the
 * user deliberately read (an `open` and a `complete` that wasn't undone) or
 * reviewed that day, bucketed into 4 levels. A plain `open` doesn't count.
 *
 * This is the counting rule the plan lists as open item #1 (§12); it's used
 * here as proposed: spec §9 says "deliberately read or reviewed".
 */

export interface ActivityEvent {
  type: "open" | "complete" | "uncomplete" | "save" | "unsave" | "summary_expand" | "skip";
  itemId: string;
  occurredAt: Date;
  /** The device's local day when it happened, "YYYY-MM-DD"; never recomputed. */
  localDay: string;
}

export interface ActivityReview {
  itemId: string;
  /** The local day of the review (in the user's time zone when it was made). */
  localDay: string;
}

/** 0 items → 0, 1 → 1, 2–3 → 2, 4 or more → 3. */
export function activityLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

/**
 * Items read per local day. A completion counts on its own day when the item
 * was opened at or before it and no later `uncomplete` cancelled it.
 */
export function readsByDay(events: ActivityEvent[]): Map<string, Set<string>> {
  const byItem = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    if (e.type !== "open" && e.type !== "complete" && e.type !== "uncomplete") continue;
    const list = byItem.get(e.itemId) ?? [];
    list.push(e);
    byItem.set(e.itemId, list);
  }
  const days = new Map<string, Set<string>>();
  for (const [itemId, list] of byItem) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    let opened = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.type === "open") opened = true;
      if (e.type !== "complete" || !opened) continue;
      const undone = list.slice(i + 1).some((later) => later.type === "uncomplete");
      if (undone) continue;
      const set = days.get(e.localDay) ?? new Set<string>();
      set.add(itemId);
      days.set(e.localDay, set);
    }
  }
  return days;
}

/** One entry per day of `month` ("YYYY-MM"). */
export function activityMonth(month: string, events: ActivityEvent[], reviews: ActivityReview[]): ActivityMonth {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const reads = readsByDay(events.filter((e) => e.localDay.startsWith(`${month}-`)));
  const reviewed = new Map<string, Set<string>>();
  for (const r of reviews) {
    if (!r.localDay.startsWith(`${month}-`)) continue;
    const set = reviewed.get(r.localDay) ?? new Set<string>();
    set.add(r.itemId);
    reviewed.set(r.localDay, set);
  }
  const days = Array.from({ length }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, "0")}`;
    const read = reads.get(day) ?? new Set<string>();
    const rev = reviewed.get(day) ?? new Set<string>();
    const distinct = new Set([...read, ...rev]);
    return { day, level: activityLevel(distinct.size), read: read.size, reviewed: rev.size };
  });
  return { month, activeDays: days.filter((d) => d.level > 0).length, days };
}
