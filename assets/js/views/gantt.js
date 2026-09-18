/**
 * Timeline (Gantt) view.
 *
 * One scroll container holds a two-column CSS grid: a sticky activity-label
 * column and a chart column whose width is `totalDays × pxPerDay`. Bars are
 * absolutely positioned inside their lane from that same day scale, so the
 * axis, the gridlines, the today line and every bar share one coordinate
 * system and cannot drift apart.
 */

import {
  addDays, diffDays, endOfMonth, formatDay, formatRange, formatTime,
  isWeekend, monthsBetween, MONTHS_SHORT, quarterOf, spanDays, startOfMonth,
  startOfWeek,
} from "../dates.js";
import { groupByCategory, groupByUnit, LIFECYCLE_LABEL } from "../store.js";

/** Zoom presets, in pixels per day. `fit` is computed from the container. */
export const ZOOM_LEVELS = [
  { id: "fit", label: "Fit all", hint: "The whole cycle on one screen" },
  { id: "months", label: "Months", pxPerDay: 3.4, hint: "Month-by-month overview" },
  { id: "weeks", label: "Weeks", pxPerDay: 9, hint: "Week-level detail" },
  { id: "days", label: "Days", pxPerDay: 26, hint: "Day-level detail" },
];

const LABEL_WIDTH = 268;
const MIN_BAR_PX = 10;
/** Past this fraction of the range, a bar's date label flips to its left. */
const FLIP_AFTER = 0.72;

export function renderGantt(container, options) {
  const {
    events, today, categories, units, categoryById,
    zoom = "fit", groupBy = "category", availableWidth = 900,
  } = options;

  container.innerHTML = "";

  if (!events.length) {
    return { summary: "No activities match the current filters" };
  }

  /* --- day scale, padded out to whole months so the axis reads cleanly --- */
  const rangeStart = startOfMonth(events.reduce((min, e) => (e.start < min ? e.start : min), events[0].start));
  const rangeEnd = endOfMonth(events.reduce((max, e) => (e.end > max ? e.end : max), events[0].end));
  const totalDays = spanDays(rangeStart, rangeEnd);

  const chartWidth = Math.max(320, availableWidth - LABEL_WIDTH - 24);
  const preset = ZOOM_LEVELS.find((level) => level.id === zoom) ?? ZOOM_LEVELS[0];
  const pxPerDay = preset.pxPerDay ?? Math.max(1.1, chartWidth / totalDays);

  const groups =
    groupBy === "unit" ? groupByUnit(events, units) : groupByCategory(events, categories);

  const scroller = document.createElement("div");
  scroller.className = "gantt";
  scroller.style.setProperty("--px-day", `${pxPerDay}px`);
  scroller.style.setProperty("--label-w", `${LABEL_WIDTH}px`);
  scroller.style.setProperty("--chart-w", `${totalDays * pxPerDay}px`);
  scroller.style.setProperty("--total-days", String(totalDays));

  const grid = document.createElement("div");
  grid.className = "gantt__grid";

  /* --- header: corner + two-tier axis --- */
  const corner = document.createElement("div");
  corner.className = "gantt__corner";
  corner.innerHTML =
    `<span class="gantt__corner-title">${groupBy === "unit" ? "Responsible unit" : "SPMS stage"}</span>` +
    `<span class="gantt__corner-sub">${events.length} activities</span>`;
  grid.append(corner);
  grid.append(buildAxis({ rangeStart, rangeEnd, pxPerDay, today }));

  /* --- gridlines + today line, one overlay behind every row --- */
  grid.append(buildGridlines({ rangeStart, rangeEnd, pxPerDay, today, totalDays }));

  /* --- rows --- */
  for (const group of groups) {
    const items = [...group.items].sort(
      (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
    );
    const groupStart = items.reduce((min, e) => (e.start < min ? e.start : min), items[0].start);
    const groupEnd = items.reduce((max, e) => (e.end > max ? e.end : max), items[0].end);

    const label = document.createElement("div");
    label.className = "glabel glabel--group";
    if (group.color) label.style.setProperty("--series", `var(--cat-${group.color})`);
    label.innerHTML =
      `<span class="glabel__swatch"></span>` +
      `<span class="glabel__text">${escapeHtml(group.label)}</span>` +
      `<span class="glabel__count">${items.length}</span>`;
    grid.append(label);

    const lane = document.createElement("div");
    lane.className = "glane glane--group";
    if (group.color) lane.style.setProperty("--series", `var(--cat-${group.color})`);
    const track = document.createElement("div");
    track.className = "gtrack";
    track.style.setProperty("--offset", String(diffDays(rangeStart, groupStart)));
    track.style.setProperty("--days", String(spanDays(groupStart, groupEnd)));
    track.title = `${group.label}: ${formatRange(groupStart, groupEnd)}`;
    lane.append(track);
    grid.append(lane);

    for (const event of items) {
      grid.append(buildRowLabel(event, categoryById));
      grid.append(buildRowLane({ event, rangeStart, pxPerDay, totalDays, categoryById }));
    }
  }

  scroller.append(grid);
  container.append(scroller);

  // Open on today when it falls inside the range, otherwise on the first activity.
  const focusISO = today >= rangeStart && today <= rangeEnd ? today : events[0].start;
  const focusPx = diffDays(rangeStart, focusISO) * pxPerDay;
  scroller.scrollLeft = Math.max(0, focusPx - chartWidth * 0.35);

  return {
    summary: `${events.length} ${events.length === 1 ? "activity" : "activities"} from ${formatDay(rangeStart)} to ${formatDay(rangeEnd)}`,
    scroller,
  };
}

/* ---------------------------------------------------------------- *
 * Axis
 * ---------------------------------------------------------------- */

function buildAxis({ rangeStart, rangeEnd, pxPerDay, today }) {
  const axis = document.createElement("div");
  axis.className = "gantt__axis";

  const months = monthsBetween(rangeStart, rangeEnd);

  /* Tier 1 — quarters when zoomed out, otherwise months. */
  const tier1 = document.createElement("div");
  tier1.className = "axis__tier axis__tier--major";
  if (pxPerDay < 6) {
    let cursor = 0;
    while (cursor < months.length) {
      const monthISO = months[cursor];
      const quarter = quarterOf(monthISO);
      const year = monthISO.slice(0, 4);
      let span = 0;
      while (
        cursor + span < months.length &&
        quarterOf(months[cursor + span]) === quarter &&
        months[cursor + span].slice(0, 4) === year
      ) {
        span += 1;
      }
      const start = months[cursor];
      const end = endOfMonth(months[cursor + span - 1]);
      tier1.append(
        axisCell({
          text: `Q${quarter} ${year}`,
          offset: diffDays(rangeStart, start),
          days: spanDays(start, end),
          major: true,
        }),
      );
      cursor += span;
    }
  } else {
    for (const monthISO of months) {
      tier1.append(
        axisCell({
          text: `${MONTHS_SHORT[Number(monthISO.slice(5, 7)) - 1]} ${monthISO.slice(0, 4)}`,
          offset: diffDays(rangeStart, monthISO),
          days: spanDays(monthISO, endOfMonth(monthISO)),
          major: true,
        }),
      );
    }
  }
  axis.append(tier1);

  /* Tier 2 — months, weeks or days, whichever the zoom can show. */
  const tier2 = document.createElement("div");
  tier2.className = "axis__tier axis__tier--minor";

  if (pxPerDay < 6) {
    for (const monthISO of months) {
      tier2.append(
        axisCell({
          text: MONTHS_SHORT[Number(monthISO.slice(5, 7)) - 1],
          offset: diffDays(rangeStart, monthISO),
          days: spanDays(monthISO, endOfMonth(monthISO)),
        }),
      );
    }
  } else if (pxPerDay < 16) {
    let cursor = startOfWeek(rangeStart) < rangeStart ? startOfWeek(rangeStart) : rangeStart;
    while (cursor <= rangeEnd) {
      const weekEnd = addDays(cursor, 6);
      const visibleStart = cursor < rangeStart ? rangeStart : cursor;
      const visibleEnd = weekEnd > rangeEnd ? rangeEnd : weekEnd;
      tier2.append(
        axisCell({
          text: String(Number(visibleStart.slice(8, 10))),
          offset: diffDays(rangeStart, visibleStart),
          days: spanDays(visibleStart, visibleEnd),
        }),
      );
      cursor = addDays(cursor, 7);
    }
  } else {
    for (let offset = 0; offset < spanDays(rangeStart, rangeEnd); offset += 1) {
      const date = addDays(rangeStart, offset);
      const cell = axisCell({
        text: String(Number(date.slice(8, 10))),
        offset,
        days: 1,
      });
      if (isWeekend(date)) cell.classList.add("is-weekend");
      if (date === today) cell.classList.add("is-today");
      tier2.append(cell);
    }
  }
  axis.append(tier2);

  // The pill rides in the axis rather than on the today line, so it stays put
  // while the rows scroll and never lands on top of the first activity.
  if (today >= rangeStart && today <= rangeEnd) {
    // A caret rather than a "Today" pill: at the widest zoom a pill sits on top
    // of the first axis label, and the red line plus caret already read as now.
    const caret = document.createElement("span");
    caret.className = "axis__today";
    caret.style.setProperty("--offset", String(diffDays(rangeStart, today) + 0.5));
    caret.title = `Today — ${formatDay(today)}`;
    axis.append(caret);
  }

  return axis;
}

function axisCell({ text, offset, days, major = false }) {
  const cell = document.createElement("div");
  cell.className = `axis__cell${major ? " is-major" : ""}`;
  cell.style.setProperty("--offset", String(offset));
  cell.style.setProperty("--days", String(days));
  cell.innerHTML = `<span>${escapeHtml(text)}</span>`;
  return cell;
}

/* ---------------------------------------------------------------- *
 * Gridlines
 * ---------------------------------------------------------------- */

function buildGridlines({ rangeStart, rangeEnd, pxPerDay, today, totalDays }) {
  const layer = document.createElement("div");
  layer.className = "gantt__grid-lines";
  layer.setAttribute("aria-hidden", "true");

  for (const monthISO of monthsBetween(rangeStart, rangeEnd)) {
    const offset = diffDays(rangeStart, monthISO);
    if (offset <= 0) continue;
    const line = document.createElement("span");
    line.className = `gline${Number(monthISO.slice(5, 7)) % 3 === 1 ? " is-quarter" : ""}`;
    line.style.setProperty("--offset", String(offset));
    layer.append(line);
  }

  if (pxPerDay >= 12) {
    for (let offset = 0; offset < totalDays; offset += 1) {
      const date = addDays(rangeStart, offset);
      if (!isWeekend(date)) continue;
      const band = document.createElement("span");
      band.className = "gband";
      band.style.setProperty("--offset", String(offset));
      band.style.setProperty("--days", "1");
      layer.append(band);
    }
  }

  if (today >= rangeStart && today <= rangeEnd) {
    const marker = document.createElement("span");
    marker.className = "gtoday";
    marker.style.setProperty("--offset", String(diffDays(rangeStart, today)));
    layer.append(marker);
  }

  return layer;
}

/* ---------------------------------------------------------------- *
 * Rows
 * ---------------------------------------------------------------- */

function buildRowLabel(event, categoryById) {
  const label = document.createElement("div");
  label.className = `glabel glabel--event is-${event.lifecycle}`;
  label.style.setProperty("--series", `var(--cat-${event.category})`);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "glabel__btn";
  button.dataset.eventId = event.id;
  button.dataset.action = "open-event";
  button.innerHTML =
    `<span class="glabel__swatch"></span>` +
    `<span class="glabel__text">${escapeHtml(event.title)}</span>`;
  button.title = `${event.title}\n${formatRange(event.start, event.end)}\n${
    categoryById.get(event.category)?.label ?? ""
  }`;
  label.append(button);
  return label;
}

function buildRowLane({ event, rangeStart, pxPerDay, totalDays, categoryById }) {
  // A bar near the right edge carries its date label on the left, so the text
  // never runs off the end of the chart.
  const endFraction =
    (diffDays(rangeStart, event.start) + spanDays(event.start, event.end)) / totalDays;
  const lane = document.createElement("div");
  lane.className = `glane is-${event.lifecycle}${endFraction > FLIP_AFTER ? " is-flip" : ""}`;

  const days = spanDays(event.start, event.end);
  const isMilestone = days === 1 && days * pxPerDay < 24;

  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = [
    "gbar",
    `is-${event.lifecycle}`,
    isMilestone ? "is-milestone" : "",
    event.allDay ? "" : "is-timed",
  ]
    .filter(Boolean)
    .join(" ");
  bar.style.setProperty("--series", `var(--cat-${event.category})`);
  bar.style.setProperty("--offset", String(diffDays(rangeStart, event.start)));
  bar.style.setProperty("--days", String(days));
  bar.style.setProperty("--min-w", `${MIN_BAR_PX}px`);
  bar.dataset.eventId = event.id;
  bar.dataset.action = "open-event";

  if (event.lifecycle === "active") {
    bar.style.setProperty("--progress", `${Math.round(event.progress * 100)}%`);
    bar.classList.add("has-progress");
  }

  const timeNote = event.allDay
    ? ""
    : ` · ${formatTime(event.startTime)}–${formatTime(event.endTime)}`;
  const tooltip =
    `${event.title}\n${formatRange(event.start, event.end)}${timeNote}\n` +
    `${categoryById.get(event.category)?.label ?? ""} · ${LIFECYCLE_LABEL[event.lifecycle]}` +
    (event.output ? `\nOutput: ${event.output}` : "");
  bar.title = tooltip;
  bar.setAttribute("aria-label", tooltip.replace(/\n/g, ". "));

  // The activity name already sits in the sticky label column, so the bar
  // carries the dates instead — in ink, beside the mark, never on the series
  // colour (where gold-on-white would fall under 3:1).
  const text = document.createElement("span");
  text.className = "gbar__label";
  text.textContent = event.allDay
    ? formatRange(event.start, event.end)
    : `${formatRange(event.start, event.end)} · ${formatTime(event.startTime)}`;
  bar.append(text);

  lane.append(bar);
  return lane;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
  );
}
