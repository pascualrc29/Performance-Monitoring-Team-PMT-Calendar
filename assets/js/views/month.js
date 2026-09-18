/**
 * Month grid. Multi-day activities render as continuous bars across the week,
 * packed into lanes so nothing overlaps. Layout is pure CSS grid — each bar is
 * placed with `grid-column: start / span n`, so there is no pixel arithmetic to
 * drift when the viewport resizes.
 */

import {
  addDays, diffDays, endOfMonth, formatDayLong, formatRange, formatTime,
  isWeekend, spanDays, startOfMonth, startOfWeek, WEEKDAYS_MIN, WEEKDAYS_SHORT,
} from "../dates.js";
import { packLanes } from "../store.js";

const VISIBLE_LANES = 4;

export function renderMonth(container, { events, anchor, today, categoryById }) {
  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const lastWeekStart = startOfWeek(monthEnd);
  const weekCount = diffDays(gridStart, lastWeekStart) / 7 + 1;

  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "month";

  root.append(weekdayHeader());

  const weeks = document.createElement("div");
  weeks.className = "month__weeks";
  weeks.style.setProperty("--week-count", String(weekCount));

  for (let index = 0; index < weekCount; index += 1) {
    const weekStart = addDays(gridStart, index * 7);
    weeks.append(renderWeek({ weekStart, monthStart, monthEnd, events, today, categoryById }));
  }

  root.append(weeks);
  container.append(root);

  const visible = events.filter((event) => event.start <= monthEnd && event.end >= gridStart);
  return {
    summary: visible.length
      ? `${visible.length} ${visible.length === 1 ? "activity" : "activities"} in view`
      : "No activities match the current filters in this month",
  };
}

function weekdayHeader() {
  const header = document.createElement("div");
  header.className = "month__weekdays";
  header.setAttribute("aria-hidden", "true");
  for (let day = 0; day < 7; day += 1) {
    const cell = document.createElement("div");
    cell.className = `month__weekday${day === 0 || day === 6 ? " is-weekend" : ""}`;
    cell.innerHTML = `<span class="u-wide">${WEEKDAYS_SHORT[day]}</span><span class="u-narrow">${WEEKDAYS_MIN[day]}</span>`;
    header.append(cell);
  }
  return header;
}

function renderWeek({ weekStart, monthStart, monthEnd, events, today, categoryById }) {
  const weekEnd = addDays(weekStart, 6);

  const week = document.createElement("div");
  week.className = "week";

  /* --- day cells (the background layer) --- */
  const grid = document.createElement("div");
  grid.className = "week__days";
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    const outside = date < monthStart || date > monthEnd;
    const cell = document.createElement("div");
    cell.className = [
      "day",
      outside ? "is-outside" : "",
      isWeekend(date) ? "is-weekend" : "",
      date === today ? "is-today" : "",
    ]
      .filter(Boolean)
      .join(" ");
    cell.dataset.date = date;

    const number = document.createElement("span");
    number.className = "day__num";
    number.textContent = String(Number(date.slice(8, 10)));
    if (date === today) {
      number.setAttribute("aria-label", `Today, ${formatDayLong(date)}`);
    }
    cell.append(number);

    if (date.slice(8, 10) === "01") {
      const marker = document.createElement("span");
      marker.className = "day__month";
      marker.textContent = new Date(`${date}T00:00:00Z`).toLocaleString("en-US", {
        month: "short",
        timeZone: "UTC",
      });
      cell.append(marker);
    }
    grid.append(cell);
  }
  week.append(grid);

  /* --- event bars (the overlay layer) --- */
  const inWeek = events
    .filter((event) => event.start <= weekEnd && event.end >= weekStart)
    .map((event) => ({
      event,
      start: event.start < weekStart ? weekStart : event.start,
      end: event.end > weekEnd ? weekEnd : event.end,
      title: event.title,
    }));

  const lanes = packLanes(inWeek);
  const laneCount = inWeek.length ? Math.max(...[...lanes.values()]) + 1 : 0;
  const overflow = Math.max(0, laneCount - VISIBLE_LANES);

  // Keep one lane's worth of height even in an empty week, so the grid rows
  // stay close to even instead of collapsing around the busy weeks.
  week.style.setProperty("--lanes", String(Math.max(1, Math.min(laneCount, VISIBLE_LANES))));
  week.style.setProperty("--lanes-full", String(Math.max(1, laneCount)));

  const bars = document.createElement("div");
  bars.className = "week__bars";

  for (const segment of inWeek) {
    const lane = lanes.get(segment);
    bars.append(
      renderBar({
        segment,
        lane,
        weekStart,
        weekEnd,
        today,
        category: categoryById.get(segment.event.category),
        hidden: lane >= VISIBLE_LANES,
      }),
    );
  }
  week.append(bars);

  if (overflow > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "week__more";
    more.textContent = `+${overflow} more`;
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const expanded = week.classList.toggle("is-expanded");
      more.setAttribute("aria-expanded", String(expanded));
      more.textContent = expanded ? "Show less" : `+${overflow} more`;
    });
    week.append(more);
  }

  return week;
}

function renderBar({ segment, lane, weekStart, weekEnd, today, category, hidden }) {
  const { event } = segment;
  const column = diffDays(weekStart, segment.start) + 1;
  const span = spanDays(segment.start, segment.end);
  const continuesLeft = event.start < weekStart;
  const continuesRight = event.end > weekEnd;

  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = [
    "bar",
    `is-${event.lifecycle}`,
    event.allDay ? "is-allday" : "is-timed",
    continuesLeft ? "is-continues-left" : "",
    continuesRight ? "is-continues-right" : "",
    hidden ? "is-overflow" : "",
  ]
    .filter(Boolean)
    .join(" ");

  bar.style.setProperty("--col", String(column));
  bar.style.setProperty("--span", String(span));
  bar.style.setProperty("--lane", String(lane + 1));
  bar.style.setProperty("--series", `var(--cat-${event.category})`);

  bar.dataset.eventId = event.id;
  bar.dataset.action = "open-event";

  const time = !event.allDay && event.startTime ? `${formatTime(event.startTime)} ` : "";
  const label = document.createElement("span");
  label.className = "bar__label";
  label.textContent = `${continuesLeft ? "◂ " : ""}${time}${event.title}`;
  bar.append(label);

  bar.title = `${event.title}\n${formatRange(event.start, event.end)}${
    time ? `\n${formatTime(event.startTime)}–${formatTime(event.endTime)}` : ""
  }\n${category?.label ?? ""}`;
  bar.setAttribute(
    "aria-label",
    `${event.title}. ${category?.label ?? ""}. ${formatRange(event.start, event.end)}.`,
  );

  if (event.start <= today && today <= event.end) bar.classList.add("is-current");

  return bar;
}
