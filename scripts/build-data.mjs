#!/usr/bin/env node
/**
 * Builds data/events.json from the public Performance Monitoring Team (PMT)
 * Google Calendar feed.
 *
 * Usage:
 *   node scripts/build-data.mjs              # fetch the live feed
 *   node scripts/build-data.mjs --offline    # re-parse data/pmt-calendar.ics
 *
 * The site reads data/events.json only, so it stays a plain static site with no
 * runtime dependency on Google (the ICS endpoint sends no CORS headers).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CALENDAR_ID =
  "1f439e7aa260c469cb2105d6e8bd9ccd4aa38bf389a48bd06a917bd947a8a43a@group.calendar.google.com";
const ICS_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(
  CALENDAR_ID,
)}/public/basic.ics`;
const HTML_URL = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(
  CALENDAR_ID,
)}&ctz=Asia%2FManila`;
const TIME_ZONE = "Asia/Manila";

/* ------------------------------------------------------------------ *
 * SPMS activity categories
 *
 * Rules are evaluated in order; the first match wins. Keep the ordering —
 * later rules are deliberately broader than earlier ones.
 * Colours: validated with the data-viz palette validator (all-pairs, both
 * modes, surfaces #F6F8FC / #0E1730). Re-validate before changing a hex.
 * ------------------------------------------------------------------ */
const CATEGORIES = [
  {
    id: "kickoff",
    label: "Kick-off & Orientation",
    short: "Kick-off",
    light: "#8c399e",
    dark: "#aa3abb",
    description: "Opening activities that set the SPMS cycle in motion.",
    test: /kick.?off|orientation/i,
  },
  {
    id: "monitoring",
    label: "Monitoring & Assessment",
    short: "Monitoring",
    light: "#be260b",
    dark: "#cc1a0a",
    description: "Quarterly assessment of office targets and budget utilisation.",
    test: /quarterly assessment|budget utilization|budget utilisation|monitoring|coaching/i,
  },
  {
    id: "targets",
    label: "Individual Targets (IPCR)",
    short: "IPCR targets",
    light: "#a68922",
    dark: "#a8912c",
    description: "Setting, calibrating and forwarding individual performance targets.",
    test: /ipcr|individual target|individual employees|setting and commitment/i,
  },
  {
    id: "contracting",
    label: "Performance Contracting (OPCR/DPCR)",
    short: "OPCR/DPCR",
    light: "#0e7556",
    dark: "#1a7551",
    description: "Preparation and calibration of office, department and division scorecards.",
    test: /(calibration|preparation|submission).*(opcr|dpcr)|(opcr|dpcr).*(calibration|preparation)/i,
  },
  {
    id: "cascading",
    label: "Approval & Cascading",
    short: "Cascading",
    light: "#0f9ac3",
    dark: "#429fc1",
    description: "Approval of targets and their communication down the organisation.",
    test: /cascad|communication of|forwarding|approval|approved/i,
  },
  {
    id: "planning",
    label: "Planning & Budgeting",
    short: "Planning",
    light: "#2d57e5",
    dark: "#4b67fa",
    description: "Formulating programmes, projects, activities and the budget behind them.",
    test: /paps|budget|workforce|plan|projection|presentation|consolidat|finaliz|finalis|target/i,
  },
];

/**
 * Relative luminance and contrast ratio, so each stage can publish the ink that
 * actually reads on it. A solid stage-coloured bar with white text would fail
 * on the gold and the cyan; picking per stage lets the bars stay vivid without
 * guessing.
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const INK_LIGHT = "#ffffff";
const INK_DARK = "#0c1428";

/** Whichever of white / near-black clears 4.5:1 on this colour; the better one wins. */
function inkFor(background) {
  const onWhite = contrast(background, INK_LIGHT);
  const onDark = contrast(background, INK_DARK);
  return onWhite >= onDark ? INK_LIGHT : INK_DARK;
}

const FALLBACK_CATEGORY = {
  id: "other",
  label: "Other Activities",
  short: "Other",
  light: "#5b6378",
  dark: "#8a93a8",
  description: "Activities that sit outside the six main SPMS stages.",
};

function classify(title) {
  for (const category of CATEGORIES) {
    if (category.test.test(title)) return category.id;
  }
  return FALLBACK_CATEGORY.id;
}

/* ------------------------------------------------------------------ *
 * ICS parsing
 * ------------------------------------------------------------------ */

/** RFC 5545 line unfolding: a leading space or tab continues the line before. */
function unfold(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#34": '"',
};

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : match,
  );
}

/** Turns a description (plain text or the light HTML Google stores) into lines. */
function descriptionToLines(raw) {
  if (!raw) return [];
  return decodeEntities(
    raw
      .replace(/<\s*(br|\/li|\/p|\/div|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * The feed writes the same office several ways ("CPD" vs "Corporate Planning
 * Department"). Fold those onto one label so the unit filter has one entry per
 * office instead of three.
 */
const UNIT_ALIASES = new Map(
  Object.entries({
    "corporate planning department": "Corporate Planning Department (CPD)",
    cpd: "Corporate Planning Department (CPD)",
    "division manager": "Division Managers",
    "division managers": "Division Managers",
    "department/division managers": "Department / Division Managers",
    "department/division manager": "Department / Division Managers",
    agms: "AGMs (Assistant General Managers)",
    gm: "GM (General Manager)",
    "cpd head": "CPD Head",
    pmt: "PMT (Performance Monitoring Team)",
    tdd: "TDD (Training & Development Division)",
  }),
);

function canonicalUnit(unit) {
  const key = unit.toLowerCase().replace(/\s*\/\s*/g, "/");
  return UNIT_ALIASES.get(key) ?? unit;
}

/**
 * Splits a "Unit/Person Responsible" string into units. Commas, " and " and
 * " & " separate; a slash does not, because the feed uses it inside single
 * names ("Department/Division Managers", "CPD Head/GM").
 */
function splitUnits(value) {
  return value
    // "Department and Division Managers" is one audience, not two.
    .replace(/departments?\s+and\s+division\s+managers?/gi, "Department/Division Managers")
    .split(/,| and | & /gi)
    .flatMap((part) => (/^[\w ]+\/[\w ]+$/.test(part.trim()) && /head|gm/i.test(part)
      ? part.split("/")
      : [part]))
    .map((unit) => unit.replace(/\s+/g, " ").trim().replace(/[.;]+$/, ""))
    .filter((unit) => unit.length > 1)
    .map(canonicalUnit);
}

function parseEvents(ics) {
  const lines = unfold(ics).split("\n");
  const events = [];
  let current = null;
  let calendarName = "Performance Monitoring Team (PMT) Calendar";

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const rawKey = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [name, ...paramParts] = rawKey.split(";");
    const params = Object.fromEntries(
      paramParts.map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      }),
    );

    if (!current) {
      if (name === "X-WR-CALNAME") calendarName = unescapeText(value);
      continue;
    }
    current[name] = { value, params };
  }

  return { calendarName, raw: events };
}

/* ------------------------------------------------------------------ *
 * Date helpers — everything is normalised to Asia/Manila calendar dates
 * ------------------------------------------------------------------ */

const manilaParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function utcStampToManila(stamp) {
  // 20261016T003000Z
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const instant = new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
  const parts = Object.fromEntries(
    manilaParts.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
    iso: instant.toISOString(),
  };
}

function dateValueToISO(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startISO, endISO) {
  const a = Date.UTC(...startISO.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  const b = Date.UTC(...endISO.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------ *
 * Event normalisation
 * ------------------------------------------------------------------ */

function normalise(raw) {
  const dtStart = raw.DTSTART;
  if (!dtStart) return null;

  const allDay = dtStart.params.VALUE === "DATE" || /^\d{8}$/.test(dtStart.value);
  let startDate;
  let endDate;
  let startTime = null;
  let endTime = null;

  if (allDay) {
    startDate = dateValueToISO(dtStart.value);
    const rawEnd = raw.DTEND ? dateValueToISO(raw.DTEND.value) : null;
    // DTEND is exclusive for all-day events; store an inclusive last day.
    endDate = rawEnd ? addDays(rawEnd, -1) : startDate;
    if (daysBetween(startDate, endDate) < 0) endDate = startDate;
  } else {
    const start = utcStampToManila(dtStart.value);
    const end = raw.DTEND ? utcStampToManila(raw.DTEND.value) : null;
    if (!start) return null;
    startDate = start.date;
    startTime = start.time;
    endDate = end ? end.date : start.date;
    endTime = end ? end.time : null;
  }

  const title = unescapeText(raw.SUMMARY?.value ?? "Untitled activity")
    .replace(/\s+/g, " ")
    .trim();

  const lines = descriptionToLines(unescapeText(raw.DESCRIPTION?.value ?? ""));
  const responsible = [];
  let output = null;
  const notes = [];

  for (const line of lines) {
    const unitMatch = /^(?:unit\s*\/\s*person\s+responsible|unit|person\s+responsible|responsible)\s*:\s*(.+)$/i.exec(line);
    if (unitMatch) {
      responsible.push(...splitUnits(unitMatch[1]));
      continue;
    }
    const outputMatch = /^output\s*:\s*(.+)$/i.exec(line);
    if (outputMatch) {
      output = outputMatch[1].trim();
      continue;
    }
    notes.push(line);
  }

  const durationDays = daysBetween(startDate, endDate) + 1;

  return {
    id: raw.UID?.value ?? `${startDate}-${title}`,
    title,
    category: classify(title),
    allDay,
    start: startDate,
    end: endDate,
    startTime,
    endTime,
    durationDays,
    responsible: [...new Set(responsible)],
    output,
    notes,
    status: raw.STATUS?.value ?? "CONFIRMED",
    updated: raw["LAST-MODIFIED"]
      ? utcStampToManila(raw["LAST-MODIFIED"].value)?.iso ?? null
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function loadIcs({ offline }) {
  const cachePath = resolve(ROOT, "data/pmt-calendar.ics");
  if (offline) return readFile(cachePath, "utf8");

  const response = await fetch(ICS_URL, {
    headers: { "user-agent": "bwd-pmt-calendar/1.0 (+static site build)" },
  });
  if (!response.ok) {
    throw new Error(`Calendar feed responded ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new Error("Calendar feed did not return an iCalendar document");
  }
  await writeFile(cachePath, text, "utf8");
  return text;
}

const offline = process.argv.includes("--offline");
const ics = await loadIcs({ offline });
const { calendarName, raw } = parseEvents(ics);

const events = raw
  .map(normalise)
  .filter(Boolean)
  .filter((event) => event.status !== "CANCELLED")
  .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

const usedCategories = new Set(events.map((event) => event.category));
const categories = [...CATEGORIES, FALLBACK_CATEGORY]
  .filter((category) => usedCategories.has(category.id))
  // `test` is a build-time regex; it has no business in the published payload.
  .map(({ test: _regex, ...rest }) => ({
    ...rest,
    ink: inkFor(rest.light),
    inkDark: inkFor(rest.dark),
    count: events.filter((event) => event.category === rest.id).length,
  }));

const units = [...new Set(events.flatMap((event) => event.responsible))].sort((a, b) =>
  a.localeCompare(b),
);

const payload = {
  calendar: {
    name: calendarName,
    organisation: "Baliwag Water District",
    timeZone: TIME_ZONE,
    icsUrl: ICS_URL,
    googleUrl: HTML_URL,
  },
  generatedAt: new Date().toISOString(),
  range: {
    start: events.at(0)?.start ?? null,
    end: events.reduce((latest, event) => (event.end > latest ? event.end : latest), events.at(0)?.end ?? ""),
  },
  categories,
  units,
  events,
};

await writeFile(resolve(ROOT, "data/events.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
  `Wrote data/events.json — ${events.length} activities, ${categories.length} categories, ` +
    `${units.length} responsible units, ${payload.range.start} → ${payload.range.end}`,
);
for (const category of categories) {
  console.log(`  ${category.id.padEnd(12)} ${String(category.count).padStart(2)}  ${category.label}`);
}
