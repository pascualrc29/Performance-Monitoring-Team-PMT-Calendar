/**
 * Date helpers for the PMT calendar.
 *
 * Every date in this app is an inclusive calendar date in Asia/Manila, carried
 * as a plain "YYYY-MM-DD" string. Arithmetic goes through UTC-anchored Date
 * objects so the viewer's own timezone can never shift a day.
 */

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const MONTHS_SHORT = MONTHS.map((month) => month.slice(0, 3));
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_MIN = ["S", "M", "T", "W", "T", "F", "S"];

/** "YYYY-MM-DD" -> Date anchored at UTC midnight. */
export function toDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Date -> "YYYY-MM-DD". */
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, delta) {
  const date = toDate(iso);
  date.setUTCDate(date.getUTCDate() + delta);
  return toISO(date);
}

export function addMonths(iso, delta) {
  const date = toDate(iso);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + delta);
  // Clamp: 31 Jan + 1 month is the last day of February, not 3 March.
  const lastDay = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
  date.setUTCDate(Math.min(targetDay, lastDay));
  return toISO(date);
}

export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Whole days from `a` to `b`; negative when b precedes a. */
export function diffDays(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

/** Inclusive day count of a range. */
export function spanDays(startISO, endISO) {
  return diffDays(startISO, endISO) + 1;
}

export function startOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso) {
  const [y, m] = iso.split("-").map(Number);
  return `${iso.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

/** Sunday that starts the week containing `iso`. */
export function startOfWeek(iso) {
  return addDays(iso, -toDate(iso).getUTCDay());
}

export function startOfQuarter(iso) {
  const month = Number(iso.slice(5, 7));
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return `${iso.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
}

export function quarterOf(iso) {
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

export function weekday(iso) {
  return toDate(iso).getUTCDay();
}

export function isWeekend(iso) {
  const day = weekday(iso);
  return day === 0 || day === 6;
}

/** Today in Asia/Manila — the calendar's own timezone, not the viewer's. */
export function todayISO(timeZone = "Asia/Manila") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ---------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------- */

export function formatDay(iso) {
  const date = toDate(iso);
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatDayLong(iso) {
  const date = toDate(iso);
  return `${WEEKDAYS_SHORT[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatMonthYear(iso) {
  const date = toDate(iso);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "Oct 22 – 30, 2026" / "Dec 28, 2026 – Jan 3, 2027" / "Nov 6, 2026". */
export function formatRange(startISO, endISO) {
  if (startISO === endISO) return formatDay(startISO);
  const a = toDate(startISO);
  const b = toDate(endISO);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
  if (sameMonth) {
    return `${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCDate()} – ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTHS_SHORT[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
  }
  return `${formatDay(startISO)} – ${formatDay(endISO)}`;
}

/** "08:30" -> "8:30 AM". */
export function formatTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatDuration(days) {
  if (days <= 1) return "1 day";
  if (days === 7) return "1 week";
  if (days % 7 === 0) return `${days / 7} weeks`;
  return `${days} days`;
}

/** "in 12 days" / "today" / "ended 3 days ago". */
export function relativeLabel(iso, today) {
  const delta = diffDays(today, iso);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  if (delta > 0) {
    if (delta < 7) return `in ${delta} days`;
    if (delta < 31) return `in ${Math.round(delta / 7)} week${delta < 11 ? "" : "s"}`;
    return `in ${Math.round(delta / 30)} months`;
  }
  const past = -delta;
  if (past < 7) return `${past} days ago`;
  if (past < 31) return `${Math.round(past / 7)} week${past < 11 ? "" : "s"} ago`;
  return `${Math.round(past / 30)} months ago`;
}

/** Inclusive list of month-start dates covering [startISO, endISO]. */
export function monthsBetween(startISO, endISO) {
  const months = [];
  let cursor = startOfMonth(startISO);
  const last = startOfMonth(endISO);
  while (cursor <= last) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** Do the inclusive ranges [aStart,aEnd] and [bStart,bEnd] share a day? */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}
