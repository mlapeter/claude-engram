/**
 * Active-day time — decay runs on days actually lived, not calendar time.
 *
 * Human forgetting comes from interference by new experience, not from the
 * clock: a month of absence is not a month of forgetting. The global meta
 * carries a monotonic activeDay counter, bumped on the first session of each
 * calendar day. Memories stamp the active day at creation; strength and gist
 * ages measure elapsed ACTIVE days, falling back to calendar age for
 * unstamped (older) memories.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./types.js";

let cached: { day: number; at: number } | null = null;
const TTL_MS = 60_000; // hooks are short-lived; the dashboard refreshes each minute

/** Current active day (monotonic counter). 0 when the system has never run. */
export function getCurrentActiveDay(): number {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.day;
  let day = 0;
  try {
    const meta = JSON.parse(readFileSync(join(getDataDir(), "global", "meta.json"), "utf-8"));
    day = Number(meta.activeDay) || 0;
  } catch { /* no meta yet */ }
  cached = { day, at: Date.now() };
  return day;
}

/** Reset the cache (tests, or after bumping the counter in-process). */
export function resetActiveDayCache(): void {
  cached = null;
}

/**
 * Age in days for decay/gisting: active-day age when both the memory stamp
 * and the counter exist, calendar age otherwise.
 */
export function ageInDays(memory: { created_at: string; created_active_day?: number | null }): number {
  const current = getCurrentActiveDay();
  if (memory.created_active_day != null && current > 0) {
    return Math.max(0, current - memory.created_active_day);
  }
  const raw = (Date.now() - new Date(memory.created_at).getTime()) / 86_400_000;
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}
