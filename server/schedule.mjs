// When tonight's tournament starts. MUST match script.js (TOUR_UTC_HOUR,
// TOUR_SCHEDULE, tourStartOn, tourCurrentStart): the server uses it only to
// remind «every evening» subscribers, who may not open the app that day.
// To move the time, add an entry from a future UTC day in BOTH places.
export const TOUR_UTC_HOUR = 13;                                      // 21:00 Ulaanbaatar…
export const TOUR_SCHEDULE = [{ from: Date.UTC(2026, 10, 24), hour: 11 }];   // …19:00 from 2026-11-24
const DAY = 24 * 3600 * 1000;

export function tourStartOn(ms) {
  const day = Math.floor(ms / DAY) * DAY;
  let hour = TOUR_UTC_HOUR;
  for (const e of TOUR_SCHEDULE) if (day >= e.from) hour = e.hour;
  return day + hour * 3600 * 1000;
}
/** Today's event: the next one, or tonight's for a few hours after it started. */
export function tourCurrentStart(now) {
  const start = tourStartOn(now);
  return start <= now - 6 * 3600 * 1000 ? tourStartOn(start + DAY) : start;
}
