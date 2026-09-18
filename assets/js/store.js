/**
 * Loads data/events.json and derives everything the views need: per-event
 * lifecycle state, the filter predicate, lane packing, and the ICS/CSV exports.
 */

import { diffDays, overlaps, spanDays, todayISO } from "./dates.js";

const DATA_URL = new URL("../../data/events.json", import.meta.url);

/** @typedef {"done"|"active"|"upcoming"} Lifecycle */

export const LIFECYCLE_LABEL = {
  done: "Completed",
  active: "In progress",
  upcoming: "Upcoming",
};

/**
 * @param {{bust?: boolean}} [options] `bust` defeats any CDN or browser cache,
 *   for the manual refresh — GitHub Pages will otherwise happily serve the
 *   previous snapshot.
 */
export async function loadCalendar({ bust = false } = {}) {
  const url = new URL(DATA_URL);
  if (bust) url.searchParams.set("t", String(Date.now()));
  const response = await fetch(url, { cache: bust ? "reload" : "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load calendar data (HTTP ${response.status})`);
  }
  const payload = await response.json();
  const today = todayISO(payload.calendar?.timeZone ?? "Asia/Manila");

  const categoryById = new Map(payload.categories.map((category) => [category.id, category]));
  const events = payload.events.map((event) => ({
    ...event,
    category: categoryById.has(event.category) ? event.category : "other",
    lifecycle: lifecycleOf(event, today),
    /** 0..1 — how far through a multi-day activity today sits. */
    progress: progressOf(event, today),
    searchText: [
      event.title,
      event.output ?? "",
      ...(event.responsible ?? []),
      ...(event.notes ?? []),
      categoryById.get(event.category)?.label ?? "",
    ]
      .join(" ")
      .toLowerCase(),
  }));

  return { ...payload, today, categoryById, events };
}

function lifecycleOf(event, today) {
  if (event.end < today) return "done";
  if (event.start > today) return "upcoming";
  return "active";
}

function progressOf(event, today) {
  const total = spanDays(event.start, event.end);
  if (event.end < today) return 1;
  if (event.start > today) return 0;
  return Math.min(1, Math.max(0, (diffDays(event.start, today) + 1) / total));
}

/* ---------------------------------------------------------------- *
 * Filtering
 * ---------------------------------------------------------------- */

/**
 * @param {object[]} events
 * @param {{query?: string, categories?: Set<string>, units?: Set<string>, lifecycles?: Set<Lifecycle>}} filters
 */
export function filterEvents(events, filters = {}) {
  const query = (filters.query ?? "").trim().toLowerCase();
  const terms = query ? query.split(/\s+/) : [];
  const categories = filters.categories;
  const units = filters.units;
  const lifecycles = filters.lifecycles;

  return events.filter((event) => {
    if (categories?.size && !categories.has(event.category)) return false;
    if (lifecycles?.size && !lifecycles.has(event.lifecycle)) return false;
    if (units?.size && !event.responsible.some((unit) => units.has(unit))) return false;
    return terms.every((term) => event.searchText.includes(term));
  });
}

export function eventsInRange(events, startISO, endISO) {
  return events.filter((event) => overlaps(event.start, event.end, startISO, endISO));
}

/* ---------------------------------------------------------------- *
 * Lane packing — used by the month grid and the timeline
 * ---------------------------------------------------------------- */

/**
 * Greedy interval packing: the first lane with no overlap wins, so long
 * activities keep a stable row and short ones fill the gaps beneath them.
 *
 * @param {Array<{start: string, end: string}>} items
 * @returns {Map<object, number>} item -> lane index
 */
export function packLanes(items) {
  const sorted = [...items].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      spanDays(b.start, b.end) - spanDays(a.start, a.end) ||
      String(a.title ?? "").localeCompare(String(b.title ?? "")),
  );
  /** @type {string[]} last occupied day per lane */
  const laneEnds = [];
  const lanes = new Map();
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    lanes.set(item, lane);
  }
  return lanes;
}

/* ---------------------------------------------------------------- *
 * Grouping
 * ---------------------------------------------------------------- */

/** Groups events by category, in the order the data file declares them. */
export function groupByCategory(events, categories) {
  return categories
    .map((category) => ({
      key: category.id,
      label: category.label,
      description: category.description,
      color: category.id,
      items: events.filter((event) => event.category === category.id),
    }))
    .filter((group) => group.items.length > 0);
}

/** Groups events by responsible unit; an event appears under each of its units. */
export function groupByUnit(events, units) {
  const groups = units
    .map((unit) => ({
      key: unit,
      label: unit,
      description: null,
      color: null,
      items: events.filter((event) => event.responsible.includes(unit)),
    }))
    .filter((group) => group.items.length > 0);

  const unassigned = events.filter((event) => event.responsible.length === 0);
  if (unassigned.length) {
    groups.push({
      key: "__unassigned",
      label: "No unit recorded",
      description: "Activities whose calendar entry does not name a responsible unit.",
      color: null,
      items: unassigned,
    });
  }
  return groups;
}

/* ---------------------------------------------------------------- *
 * Exports
 * ---------------------------------------------------------------- */

function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 requires lines of at most 75 octets, folded with a leading space. */
function foldLine(line) {
  if (line.length <= 73) return line;
  const chunks = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    chunks.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) chunks.push(` ${rest}`);
  return chunks.join("\r\n");
}

const compact = (iso) => iso.replace(/-/g, "");

function stampNow() {
  return `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/** Builds a downloadable iCalendar document for the given events. */
export function toICS(events, calendar, categoryById) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Baliwag Water District//PMT Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timeZone}`,
  ];

  for (const event of events) {
    const description = [
      event.responsible.length ? `Unit/Person Responsible: ${event.responsible.join(", ")}` : null,
      event.output ? `Output: ${event.output}` : null,
      ...event.notes,
    ]
      .filter(Boolean)
      .join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(event.id)}`);
    lines.push(`DTSTAMP:${stampNow()}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compact(event.start)}`);
      // DTEND is exclusive on the wire; our stored end date is inclusive.
      const exclusiveEnd = new Date(Date.UTC(...event.end.split("-").map((n, i) => (i === 1 ? +n - 1 : +n))));
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      lines.push(`DTEND;VALUE=DATE:${compact(exclusiveEnd.toISOString().slice(0, 10))}`);
    } else {
      lines.push(`DTSTART;TZID=${calendar.timeZone}:${compact(event.start)}T${(event.startTime ?? "00:00").replace(":", "")}00`);
      lines.push(`DTEND;TZID=${calendar.timeZone}:${compact(event.end)}T${(event.endTime ?? event.startTime ?? "00:00").replace(":", "")}00`);
    }
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    lines.push(`CATEGORIES:${icsEscape(categoryById.get(event.category)?.label ?? "Other")}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

const csvCell = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCSV(events, categoryById) {
  const header = [
    "Activity", "Category", "Start date", "End date", "Duration (days)",
    "Start time", "End time", "Responsible unit(s)", "Expected output", "Notes", "Status",
  ];
  const rows = events.map((event) => [
    event.title,
    categoryById.get(event.category)?.label ?? "Other",
    event.start,
    event.end,
    event.durationDays,
    event.startTime ?? "",
    event.endTime ?? "",
    event.responsible.join("; "),
    event.output ?? "",
    event.notes.join(" | "),
    LIFECYCLE_LABEL[event.lifecycle],
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** A "add this one activity to my own Google Calendar" link. */
export function googleAddUrl(event, calendar) {
  const exclusiveEnd = new Date(Date.UTC(...event.end.split("-").map((n, i) => (i === 1 ? +n - 1 : +n))));
  exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
  const dates = event.allDay
    ? `${compact(event.start)}/${compact(exclusiveEnd.toISOString().slice(0, 10))}`
    : `${compact(event.start)}T${(event.startTime ?? "00:00").replace(":", "")}00/${compact(event.end)}T${(event.endTime ?? "23:59").replace(":", "")}00`;

  const details = [
    event.responsible.length ? `Unit/Person Responsible: ${event.responsible.join(", ")}` : null,
    event.output ? `Output: ${event.output}` : null,
    ...event.notes,
  ]
    .filter(Boolean)
    .join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    ctz: calendar.timeZone,
  });
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
