// Deterministic projection-level fabricated-date scan. Run 1 found (by hand) that
// policies fabricate precise dates via weekday arithmetic on relative references —
// the "(July 11-13, 2024)" hallucination class. This mechanizes that scan: any
// precise date in a projection that is neither a session date nor a date stated in
// the fixture counts as fabricated. Hits are audited by hand before being trusted
// (run-1 method lesson).

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const FIXTURE_YEAR = 2025;

// "february 3" -> "2025-02-03"
function englishToIso(stated: string): string | null {
  const m = stated.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2})$/);
  if (!m || !(m[1] in MONTHS)) return null;
  return `${FIXTURE_YEAR}-${String(MONTHS[m[1]]).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

export type DateScanResult = { fabricated: string[]; count: number };

// statedDates: english "month day" strings from the probes file.
// sessionDates: ISO dates of the fixture sessions.
export function scanFabricatedDates(
  projection: string,
  statedDates: string[],
  sessionDates: string[],
): DateScanResult {
  const allowedIso = new Set<string>(sessionDates);
  const allowedEnglish = new Set<string>();
  for (const s of statedDates) {
    allowedEnglish.add(s.trim().toLowerCase());
    const iso = englishToIso(s);
    if (iso) allowedIso.add(iso);
  }

  const hits = new Set<string>();
  const lower = projection.toLowerCase();

  // ISO dates.
  for (const m of lower.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (!allowedIso.has(m[1])) hits.add(m[1]);
  }

  // English "Month D" (optionally "Month D, YYYY"). Require a day so bare
  // month-year mentions ("October 2025", a stated fact) never trip.
  const monthAlt = Object.keys(MONTHS).join("|");
  const englishRe = new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?!\\d)(?:,\\s*(\\d{4}))?`, "g");
  for (const m of lower.matchAll(englishRe)) {
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    // "January 2025"-style month-year mentions match with the year as the "day";
    // skip when the "day" token is actually a 4-digit year (already excluded by
    // (?!\d)) — day tokens here are 1-2 digits, so this is a real month-day.
    const key = `${m[1]} ${day}`;
    const year = m[3] ? Number(m[3]) : FIXTURE_YEAR;
    if (year !== FIXTURE_YEAR) {
      hits.add(`${m[1]} ${day}, ${year}`);
      continue;
    }
    if (!allowedEnglish.has(key)) hits.add(key);
  }

  const fabricated = [...hits].sort();
  return { fabricated, count: fabricated.length };
}
