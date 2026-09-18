/**
 * App shell: state, hash routing, filters, the KPI strip and view dispatch.
 *
 * State lives in one object and is mirrored into the URL hash, so any view,
 * month, zoom or filter combination is a shareable link.
 */

import {
  addMonths, diffDays, formatDay, formatMonthYear, relativeLabel,
  spanDays, startOfMonth,
} from "./dates.js";
import {
  download, filterEvents, LIFECYCLE_LABEL, loadCalendar, toCSV, toICS,
} from "./store.js";
import { createDetailDrawer } from "./detail.js";
import { renderMonth } from "./views/month.js";
import { renderGantt, ZOOM_LEVELS } from "./views/gantt.js";
import { renderAgenda, renderTable } from "./views/list.js";

const VIEWS = [
  { id: "month", label: "Month", key: "1" },
  { id: "timeline", label: "Timeline", key: "2" },
  { id: "agenda", label: "Agenda", key: "3" },
  { id: "table", label: "Table", key: "4" },
];

const LIFECYCLES = ["active", "upcoming", "done"];
const THEME_KEY = "bwd-pmt-theme";

const $ = (selector, scope = document) => scope.querySelector(selector);

let data = null;
let drawer = null;
let state = null;

/* ---------------------------------------------------------------- *
 * Theme
 * ---------------------------------------------------------------- */

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    document.documentElement.dataset.theme = stored;
  }
  syncThemeButton();
  $("#theme-toggle").addEventListener("click", () => {
    const current =
      document.documentElement.dataset.theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    syncThemeButton();
    if (state?.view === "timeline") render();
  });
}

function syncThemeButton() {
  const isDark =
    (document.documentElement.dataset.theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  const button = $("#theme-toggle");
  button.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  button.dataset.mode = isDark ? "dark" : "light";
}

/* ---------------------------------------------------------------- *
 * State <-> URL
 * ---------------------------------------------------------------- */

function defaultState() {
  const today = data.today;
  const inRange = today >= data.range.start && today <= data.range.end;
  return {
    view: "month",
    anchor: startOfMonth(inRange ? today : data.range.start),
    zoom: "fit",
    groupBy: "category",
    query: "",
    categories: new Set(),
    units: new Set(),
    lifecycles: new Set(),
    sort: { key: "dates", direction: "asc" },
  };
}

function readHash() {
  const next = defaultState();
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));

  const view = params.get("view");
  if (VIEWS.some((entry) => entry.id === view)) next.view = view;

  const month = params.get("d");
  if (month && /^\d{4}-\d{2}$/.test(month)) next.anchor = `${month}-01`;

  const zoom = params.get("zoom");
  if (ZOOM_LEVELS.some((level) => level.id === zoom)) next.zoom = zoom;

  const group = params.get("group");
  if (group === "unit" || group === "category") next.groupBy = group;

  next.query = params.get("q") ?? "";

  const known = new Set(data.categories.map((category) => category.id));
  for (const id of (params.get("cat") ?? "").split(",").filter(Boolean)) {
    if (known.has(id)) next.categories.add(id);
  }
  const knownUnits = new Set(data.units);
  for (const unit of (params.get("unit") ?? "").split("~").filter(Boolean)) {
    if (knownUnits.has(unit)) next.units.add(unit);
  }
  for (const life of (params.get("life") ?? "").split(",").filter(Boolean)) {
    if (LIFECYCLES.includes(life)) next.lifecycles.add(life);
  }

  const sort = params.get("sort");
  if (sort) {
    const [key, direction] = sort.split(":");
    next.sort = { key, direction: direction === "desc" ? "desc" : "asc" };
  }
  return next;
}

function writeHash({ replace = false } = {}) {
  const params = new URLSearchParams();
  params.set("view", state.view);
  if (state.view === "month") params.set("d", state.anchor.slice(0, 7));
  if (state.view === "timeline") {
    params.set("zoom", state.zoom);
    params.set("group", state.groupBy);
  }
  if (state.view === "table") params.set("sort", `${state.sort.key}:${state.sort.direction}`);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.categories.size) params.set("cat", [...state.categories].join(","));
  if (state.units.size) params.set("unit", [...state.units].join("~"));
  if (state.lifecycles.size) params.set("life", [...state.lifecycles].join(","));

  const hash = `#${params}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

async function boot() {
  initTheme();

  try {
    data = await loadCalendar();
  } catch (error) {
    $("#view").innerHTML =
      `<div class="notice notice--error"><h2>The calendar could not be loaded</h2>` +
      `<p>${error.message}. If you are opening <code>index.html</code> straight from disk, ` +
      `serve the folder over HTTP instead — browsers block <code>fetch</code> on ` +
      `<code>file://</code> URLs.</p></div>`;
    $("#app-loading")?.remove();
    return;
  }

  document.documentElement.style.setProperty("--cat-other", "var(--cat-fallback)");
  injectCategoryColors();

  state = readHash();
  drawer = createDetailDrawer({
    root: document.body,
    calendar: data.calendar,
    categoryById: data.categoryById,
    today: data.today,
  });

  $("#app-loading")?.remove();
  buildChrome();
  render();
  writeHash({ replace: true });

  window.addEventListener("hashchange", () => {
    state = readHash();
    syncControls();
    render();
  });

  window.addEventListener("keydown", onKeydown);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (state.view !== "timeline" || state.zoom !== "fit") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 180);
  });
}

/** Category colours live in the data file, so publish them as CSS variables. */
function injectCategoryColors() {
  const light = [];
  const dark = [];
  for (const category of data.categories) {
    light.push(`--cat-${category.id}: ${category.light};`);
    dark.push(`--cat-${category.id}: ${category.dark};`);
  }
  const style = document.createElement("style");
  style.textContent =
    `:root { ${light.join(" ")} }\n` +
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark.join(" ")} } }\n` +
    `:root[data-theme="dark"] { ${dark.join(" ")} }\n`;
  document.head.append(style);
}

/* ---------------------------------------------------------------- *
 * Chrome (toolbar, legend, KPIs)
 * ---------------------------------------------------------------- */

function buildChrome() {
  const { calendar } = data;
  $("#calendar-name").textContent = calendar.name;
  $("#subscribe-link").href = calendar.googleUrl;
  $("#ics-link").href = calendar.icsUrl;
  $("#generated-at").textContent = new Date(data.generatedAt).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: calendar.timeZone,
  });
  $("#today-label").textContent = formatDay(data.today);

  /* view switcher */
  const switcher = $("#view-switch");
  switcher.innerHTML = "";
  for (const view of VIEWS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg__btn";
    button.dataset.view = view.id;
    button.textContent = view.label;
    button.addEventListener("click", () => setState({ view: view.id }));
    switcher.append(button);
  }

  /* month nav */
  $("#nav-prev").addEventListener("click", () => setState({ anchor: addMonths(state.anchor, -1) }));
  $("#nav-next").addEventListener("click", () => setState({ anchor: addMonths(state.anchor, 1) }));
  $("#nav-today").addEventListener("click", () => setState({ anchor: startOfMonth(data.today) }));

  /* timeline controls */
  const zoomGroup = $("#zoom-switch");
  zoomGroup.innerHTML = "";
  for (const level of ZOOM_LEVELS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg__btn";
    button.dataset.zoom = level.id;
    button.textContent = level.label;
    button.title = level.hint;
    button.addEventListener("click", () => setState({ zoom: level.id }));
    zoomGroup.append(button);
  }

  const groupSelect = $("#group-by");
  groupSelect.addEventListener("change", () => setState({ groupBy: groupSelect.value }));

  /* search */
  const search = $("#search");
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setState({ query: search.value }, { replace: true }), 180);
  });
  $("#search-clear").addEventListener("click", () => {
    search.value = "";
    setState({ query: "" });
    search.focus();
  });

  /* unit filter */
  const unitSelect = $("#unit-filter");
  unitSelect.innerHTML = `<option value="">All units</option>`;
  for (const unit of data.units) {
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = unit;
    unitSelect.append(option);
  }
  unitSelect.addEventListener("change", () => {
    setState({ units: unitSelect.value ? new Set([unitSelect.value]) : new Set() });
  });

  /* status filter */
  const statusSelect = $("#status-filter");
  statusSelect.innerHTML = `<option value="">Any status</option>`;
  for (const life of LIFECYCLES) {
    const option = document.createElement("option");
    option.value = life;
    option.textContent = LIFECYCLE_LABEL[life];
    statusSelect.append(option);
  }
  statusSelect.addEventListener("change", () => {
    setState({ lifecycles: statusSelect.value ? new Set([statusSelect.value]) : new Set() });
  });

  $("#reset-filters").addEventListener("click", () =>
    setState({ query: "", categories: new Set(), units: new Set(), lifecycles: new Set() }),
  );

  /* legend / category filter */
  const legend = $("#legend");
  legend.innerHTML = "";
  for (const category of data.categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.category = category.id;
    chip.style.setProperty("--series", `var(--cat-${category.id})`);
    chip.setAttribute("aria-pressed", "false");
    chip.title = category.description ?? category.label;
    chip.innerHTML =
      `<span class="chip__swatch"></span>` +
      `<span class="chip__label">${category.label}</span>` +
      `<span class="chip__count">${category.count}</span>`;
    chip.addEventListener("click", () => {
      const next = new Set(state.categories);
      if (next.has(category.id)) next.delete(category.id);
      else next.add(category.id);
      setState({ categories: next });
    });
    legend.append(chip);
  }

  /* exports */
  $("#export-ics").addEventListener("click", () => {
    const events = visibleEvents();
    download(
      `bwd-pmt-calendar-${data.today}.ics`,
      toICS(events, data.calendar, data.categoryById),
      "text/calendar",
    );
  });
  $("#export-csv").addEventListener("click", () => {
    download(`bwd-pmt-calendar-${data.today}.csv`, toCSV(visibleEvents(), data.categoryById), "text/csv");
  });
  $("#print").addEventListener("click", () => window.print());

  /* event delegation for every view */
  const view = $("#view");
  view.addEventListener("click", (clickEvent) => {
    const target = clickEvent.target.closest('[data-action="open-event"]');
    if (!target) return;
    const event = data.events.find((item) => item.id === target.dataset.eventId);
    if (event) drawer.open(event);
  });
  view.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
    const target = keyEvent.target.closest?.('tr[data-action="open-event"]');
    if (!target) return;
    keyEvent.preventDefault();
    const event = data.events.find((item) => item.id === target.dataset.eventId);
    if (event) drawer.open(event);
  });

  syncControls();
}

function syncControls() {
  for (const button of document.querySelectorAll("#view-switch .seg__btn")) {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "true" : "false");
  }
  for (const button of document.querySelectorAll("#zoom-switch .seg__btn")) {
    const active = button.dataset.zoom === state.zoom;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "true" : "false");
  }
  for (const chip of document.querySelectorAll("#legend .chip")) {
    const active = state.categories.has(chip.dataset.category);
    chip.classList.toggle("is-active", active);
    chip.classList.toggle("is-dimmed", state.categories.size > 0 && !active);
    chip.setAttribute("aria-pressed", String(active));
  }

  $("#search").value = state.query;
  $("#search-clear").hidden = !state.query;
  $("#unit-filter").value = [...state.units][0] ?? "";
  $("#status-filter").value = [...state.lifecycles][0] ?? "";
  $("#group-by").value = state.groupBy;

  $("#month-nav").hidden = state.view !== "month";
  $("#timeline-controls").hidden = state.view !== "timeline";
  $("#period-label").textContent =
    state.view === "month"
      ? formatMonthYear(state.anchor)
      : `${formatDay(data.range.start)} – ${formatDay(data.range.end)}`;

  const filterCount =
    (state.query.trim() ? 1 : 0) + state.categories.size + state.units.size + state.lifecycles.size;
  $("#reset-filters").hidden = filterCount === 0;
  $("#filter-count").textContent = filterCount ? `${filterCount} active` : "";
}

function setState(patch, { replace = false } = {}) {
  state = { ...state, ...patch };
  writeHash({ replace });
  syncControls();
  render();
}

/* ---------------------------------------------------------------- *
 * Render
 * ---------------------------------------------------------------- */

function visibleEvents() {
  return filterEvents(data.events, {
    query: state.query,
    categories: state.categories,
    units: state.units,
    lifecycles: state.lifecycles,
  });
}

function render() {
  const events = visibleEvents();
  renderStats(events);

  const container = $("#view");
  container.dataset.view = state.view;

  let result;
  if (state.view === "month") {
    result = renderMonth(container, {
      events,
      anchor: state.anchor,
      today: data.today,
      categoryById: data.categoryById,
    });
  } else if (state.view === "timeline") {
    result = renderGantt(container, {
      events,
      today: data.today,
      categories: data.categories,
      units: data.units,
      categoryById: data.categoryById,
      zoom: state.zoom,
      groupBy: state.groupBy,
      availableWidth: container.clientWidth || window.innerWidth,
    });
  } else if (state.view === "agenda") {
    result = renderAgenda(container, {
      events,
      today: data.today,
      categoryById: data.categoryById,
    });
  } else {
    result = renderTable(container, {
      events,
      categoryById: data.categoryById,
      sort: state.sort,
      onSort: (key, direction) => setState({ sort: { key, direction } }),
    });
  }

  if (!events.length) {
    container.innerHTML =
      `<div class="notice"><h2>Nothing matches those filters</h2>` +
      `<p>Try clearing the search box or re-enabling an SPMS stage in the legend above.</p>` +
      `<button type="button" class="btn btn--primary" id="empty-reset">Clear all filters</button></div>`;
    $("#empty-reset").addEventListener("click", () =>
      setState({ query: "", categories: new Set(), units: new Set(), lifecycles: new Set() }),
    );
  }

  $("#view-status").textContent = `${VIEWS.find((view) => view.id === state.view).label} view. ${
    result?.summary ?? ""
  }`;
}

function renderStats(events) {
  const today = data.today;
  const active = events.filter((event) => event.lifecycle === "active");
  const upcoming = events
    .filter((event) => event.lifecycle === "upcoming")
    .sort((a, b) => a.start.localeCompare(b.start));
  const done = events.filter((event) => event.lifecycle === "done");

  const cycleDays = spanDays(data.range.start, data.range.end);
  const elapsed = Math.min(cycleDays, Math.max(0, diffDays(data.range.start, today) + 1));
  const pct = Math.round((elapsed / cycleDays) * 100);

  const next = upcoming[0];

  const tiles = [
    {
      value: String(events.length),
      label: events.length === data.events.length ? "Activities in the cycle" : "Activities shown",
      note:
        events.length === data.events.length
          ? `${formatDay(data.range.start)} – ${formatDay(data.range.end)}`
          : `of ${data.events.length} in the cycle`,
    },
    {
      value: String(active.length),
      label: "Running today",
      note: active.length
        ? active[0].title.length > 38
          ? `${active[0].title.slice(0, 36)}…`
          : active[0].title
        : "Nothing scheduled for today",
      tone: active.length ? "active" : "muted",
    },
    {
      value: next ? String(Math.max(0, diffDays(today, next.start))) : "—",
      unit: next ? "days" : "",
      label: "Until the next activity",
      note: next ? `${next.title.length > 38 ? `${next.title.slice(0, 36)}…` : next.title}` : "No upcoming activity",
      tone: "upcoming",
    },
    {
      value: `${pct}%`,
      label: "Cycle elapsed",
      note: `${done.length} of ${events.length} activities completed`,
      meter: pct,
    },
  ];

  $("#stats").innerHTML = tiles
    .map(
      (tile) => `
      <div class="stat${tile.tone ? ` stat--${tile.tone}` : ""}">
        <p class="stat__value">${tile.value}${tile.unit ? `<span class="stat__unit">${tile.unit}</span>` : ""}</p>
        <p class="stat__label">${tile.label}</p>
        <p class="stat__note">${escapeHtml(tile.note)}</p>
        ${
          tile.meter != null
            ? `<div class="stat__meter" role="img" aria-label="${tile.meter} percent of the cycle elapsed"><span style="width:${tile.meter}%"></span></div>`
            : ""
        }
      </div>`,
    )
    .join("");

  $("#next-up").innerHTML = next
    ? `<span class="nextup__label">Next up</span>` +
      `<button type="button" class="nextup__btn" data-action="open-event" data-event-id="${escapeHtml(next.id)}">` +
      `<span class="nextup__title">${escapeHtml(next.title)}</span>` +
      `<span class="nextup__when">${escapeHtml(formatDay(next.start))} · ${escapeHtml(relativeLabel(next.start, today))}</span>` +
      `</button>`
    : "";
}

/* ---------------------------------------------------------------- *
 * Keyboard
 * ---------------------------------------------------------------- */

function onKeydown(keyEvent) {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

  if (keyEvent.key === "Escape") {
    if (drawer?.isOpen) drawer.close();
    else if (typing) document.activeElement.blur();
    return;
  }
  if (keyEvent.key === "/" && !typing) {
    keyEvent.preventDefault();
    $("#search").focus();
    return;
  }
  if (typing || keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) return;

  const view = VIEWS.find((entry) => entry.key === keyEvent.key);
  if (view) {
    setState({ view: view.id });
    return;
  }
  if (keyEvent.key === "t" || keyEvent.key === "T") {
    setState({ anchor: startOfMonth(data.today), view: state.view === "timeline" ? "timeline" : state.view });
    return;
  }
  if (state.view !== "month") return;
  if (keyEvent.key === "ArrowLeft") setState({ anchor: addMonths(state.anchor, -1) });
  if (keyEvent.key === "ArrowRight") setState({ anchor: addMonths(state.anchor, 1) });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
  );
}

boot();
