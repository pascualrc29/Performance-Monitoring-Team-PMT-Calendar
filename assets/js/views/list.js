/**
 * Agenda and table views.
 *
 * The table is the accessible fallback for both visual views: the same rows,
 * sortable, printable and copy-pasteable into a memo.
 */

import {
  formatDay, formatDuration, formatMonthYear, formatRange, formatTime,
  relativeLabel, startOfMonth,
} from "../dates.js";
import { LIFECYCLE_LABEL } from "../store.js";

/* ---------------------------------------------------------------- *
 * Agenda
 * ---------------------------------------------------------------- */

export function renderAgenda(container, { events, today, categoryById }) {
  container.innerHTML = "";

  if (!events.length) {
    return { summary: "No activities match the current filters" };
  }

  const sorted = [...events].sort(
    (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
  );

  const root = document.createElement("div");
  root.className = "agenda";

  let currentMonth = null;
  let nextMarkerPlaced = false;

  for (const event of sorted) {
    const month = startOfMonth(event.start);
    if (month !== currentMonth) {
      currentMonth = month;
      const heading = document.createElement("h3");
      heading.className = "agenda__month";
      heading.innerHTML =
        `<span>${formatMonthYear(month)}</span>` +
        `<span class="agenda__month-count">${
          sorted.filter((item) => startOfMonth(item.start) === month).length
        } activities</span>`;
      root.append(heading);
    }

    if (!nextMarkerPlaced && event.end >= today) {
      nextMarkerPlaced = true;
      const marker = document.createElement("p");
      marker.className = "agenda__now";
      marker.innerHTML = `<span>From here on — today is ${formatDay(today)}</span>`;
      root.append(marker);
    }

    root.append(agendaCard(event, today, categoryById));
  }

  container.append(root);
  return {
    summary: `${sorted.length} ${sorted.length === 1 ? "activity" : "activities"} listed`,
  };
}

function agendaCard(event, today, categoryById) {
  const category = categoryById.get(event.category);

  const card = document.createElement("button");
  card.type = "button";
  card.className = `acard is-${event.lifecycle}`;
  card.style.setProperty("--series", `var(--cat-${event.category})`);
  card.dataset.eventId = event.id;
  card.dataset.action = "open-event";

  const when = document.createElement("div");
  when.className = "acard__when";
  when.innerHTML =
    `<span class="acard__day">${Number(event.start.slice(8, 10))}</span>` +
    `<span class="acard__dow">${new Date(`${event.start}T00:00:00Z`).toLocaleString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    })}</span>`;
  card.append(when);

  const body = document.createElement("div");
  body.className = "acard__body";

  const title = document.createElement("span");
  title.className = "acard__title";
  title.textContent = event.title;
  body.append(title);

  const meta = document.createElement("span");
  meta.className = "acard__meta";
  const bits = [formatRange(event.start, event.end)];
  if (!event.allDay && event.startTime) {
    bits.push(`${formatTime(event.startTime)}–${formatTime(event.endTime)}`);
  }
  bits.push(formatDuration(event.durationDays));
  meta.textContent = bits.join(" · ");
  body.append(meta);

  const tags = document.createElement("span");
  tags.className = "acard__tags";
  tags.innerHTML = `<span class="tag tag--series">${escapeHtml(category?.short ?? "Other")}</span>`;
  for (const unit of event.responsible.slice(0, 3)) {
    tags.innerHTML += `<span class="tag">${escapeHtml(unit)}</span>`;
  }
  if (event.responsible.length > 3) {
    tags.innerHTML += `<span class="tag tag--muted">+${event.responsible.length - 3}</span>`;
  }
  body.append(tags);

  if (event.output) {
    const output = document.createElement("span");
    output.className = "acard__output";
    output.innerHTML = `<span class="acard__output-label">Output</span> ${escapeHtml(event.output)}`;
    body.append(output);
  }

  card.append(body);

  const status = document.createElement("div");
  status.className = "acard__status";
  status.innerHTML =
    `<span class="pill pill--${event.lifecycle}">${LIFECYCLE_LABEL[event.lifecycle]}</span>` +
    `<span class="acard__rel">${escapeHtml(
      event.lifecycle === "done"
        ? `ended ${relativeLabel(event.end, today)}`
        : event.lifecycle === "active"
          ? `runs to ${formatDay(event.end)}`
          : `starts ${relativeLabel(event.start, today)}`,
    )}</span>`;
  card.append(status);

  return card;
}

/* ---------------------------------------------------------------- *
 * Table
 * ---------------------------------------------------------------- */

const COLUMNS = [
  { id: "title", label: "Activity", sort: (e) => e.title.toLowerCase() },
  { id: "category", label: "SPMS stage", sort: (e, ctx) => ctx.categoryById.get(e.category)?.label ?? "" },
  { id: "dates", label: "Schedule", sort: (e) => e.start, numeric: false },
  { id: "duration", label: "Duration", sort: (e) => e.durationDays, numeric: true },
  { id: "responsible", label: "Responsible unit(s)", sort: (e) => e.responsible.join(", ").toLowerCase() },
  { id: "output", label: "Expected output", sort: (e) => (e.output ?? "").toLowerCase() },
  { id: "status", label: "Status", sort: (e) => ["active", "upcoming", "done"].indexOf(e.lifecycle), numeric: true },
];

export function renderTable(container, { events, categoryById, sort, onSort }) {
  container.innerHTML = "";

  if (!events.length) {
    return { summary: "No activities match the current filters" };
  }

  const column = COLUMNS.find((col) => col.id === sort.key) ?? COLUMNS[2];
  const direction = sort.direction === "desc" ? -1 : 1;
  const rows = [...events].sort((a, b) => {
    const av = column.sort(a, { categoryById });
    const bv = column.sort(b, { categoryById });
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return a.start.localeCompare(b.start);
  });

  const wrap = document.createElement("div");
  wrap.className = "tablewrap";

  const table = document.createElement("table");
  table.className = "dtable";
  table.innerHTML = `<caption class="u-visually-hidden">Performance Monitoring Team activities, sortable</caption>`;

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    const active = col.id === sort.key;
    th.setAttribute("aria-sort", active ? (sort.direction === "desc" ? "descending" : "ascending") : "none");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dtable__sort${active ? " is-active" : ""}`;
    button.innerHTML = `${escapeHtml(col.label)}<span class="dtable__arrow">${
      active ? (sort.direction === "desc" ? "↓" : "↑") : "↕"
    }</span>`;
    button.addEventListener("click", () => {
      onSort(col.id, active && sort.direction === "asc" ? "desc" : "asc");
    });
    th.append(button);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const event of rows) {
    const tr = document.createElement("tr");
    tr.className = `is-${event.lifecycle}`;
    tr.dataset.eventId = event.id;
    tr.dataset.action = "open-event";
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `${event.title}. Open details.`);

    const timeNote =
      !event.allDay && event.startTime
        ? `<br><span class="dtable__sub">${formatTime(event.startTime)}–${formatTime(event.endTime)}</span>`
        : "";

    tr.innerHTML =
      `<th scope="row"><span class="dtable__dot" style="--series: var(--cat-${event.category})"></span>${escapeHtml(event.title)}</th>` +
      `<td>${escapeHtml(categoryById.get(event.category)?.label ?? "Other")}</td>` +
      `<td>${escapeHtml(formatRange(event.start, event.end))}${timeNote}</td>` +
      `<td class="u-num">${escapeHtml(formatDuration(event.durationDays))}</td>` +
      `<td>${event.responsible.length ? escapeHtml(event.responsible.join(", ")) : '<span class="dtable__sub">Not recorded</span>'}</td>` +
      `<td>${event.output ? escapeHtml(event.output) : '<span class="dtable__sub">—</span>'}</td>` +
      `<td><span class="pill pill--${event.lifecycle}">${LIFECYCLE_LABEL[event.lifecycle]}</span></td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);

  return {
    summary: `${rows.length} ${rows.length === 1 ? "activity" : "activities"} in the table, sorted by ${column.label.toLowerCase()}`,
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
  );
}
