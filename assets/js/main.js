/**
 * App shell: state, hash routing, filters, the KPI strip and view dispatch.
 *
 * State lives in one object and is mirrored into the URL hash, so any view,
 * month, zoom or filter combination is a shareable link.
 */

import {
  addMonths, diffDays, formatDay, MONTHS, relativeLabel, spanDays, startOfMonth,
} from "./dates.js";
import {
  ALL_YEARS, download, filterEvents, LIFECYCLE_LABEL, loadCalendar, toCSV,
  toICS, yearsCovered,
} from "./store.js";
import { createDetailDrawer } from "./detail.js";
import { initPWA } from "./pwa.js";
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
/** Fingerprint of the loaded schedule, so a refresh can say whether it changed. */
let lastSignature = "";
let refreshing = false;

/* ---------------------------------------------------------------- *
 * Theme
 * ---------------------------------------------------------------- */

/**
 * Light is the default — the inline script in index.html has already stamped
 * data-theme before first paint, so this only has to keep the switch in step.
 */
function initTheme() {
  syncThemeSwitch();
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // A private window can refuse storage; the choice then lasts this visit.
    }
    syncThemeSwitch();
    if (state?.view === "timeline") render();
  });
}

function syncThemeSwitch() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const button = $("#theme-toggle");
  button.setAttribute("aria-checked", String(isDark));
  button.setAttribute("aria-label", isDark ? "Dark mode, on" : "Dark mode, off");
}

/* ---------------------------------------------------------------- *
 * State <-> URL
 * ---------------------------------------------------------------- */

function defaultState() {
  const today = data.today;
  const inRange = today >= data.range.start && today <= data.range.end;
  const years = yearsCovered(data.range);
  return {
    view: "month",
    anchor: startOfMonth(inRange ? today : data.range.start),
    // Open on the year we are in, not on the whole cycle — the timeline of a
    // 14-month cycle is unreadable as a first impression.
    period: years.includes(today.slice(0, 4)) ? today.slice(0, 4) : years[0],
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

  const period = params.get("y");
  if (period === ALL_YEARS || yearsCovered(data.range).includes(period)) next.period = period;

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
  params.set("y", state.period);
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
  initPWA({
    onUpdate: (apply) => {
      // Say so before the reload, so the jump is not a surprise.
      toast("A new version is ready", "Reloading to pick it up\u2026");
      setTimeout(apply, 1200);
    },
    onMessage: toast,
  });

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
  lastSignature = signatureOf(data);

  state = readHash();
  drawer = createDetailDrawer({
    root: document.body,
    calendar: data.calendar,
    categoryById: data.categoryById,
    today: data.today,
  });

  $("#app-loading")?.remove();
  buildChrome();
  applyData();
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

/**
 * Category colours live in the data file, so publish them as CSS variables.
 * One reused <style> element, because a refresh calls this again.
 */
function injectCategoryColors() {
  const light = [];
  const dark = [];
  for (const category of data.categories) {
    light.push(`--cat-${category.id}: ${category.light};`);
    dark.push(`--cat-${category.id}: ${category.dark};`);
  }
  let style = document.getElementById("category-colors");
  if (!style) {
    style = document.createElement("style");
    style.id = "category-colors";
    document.head.append(style);
  }
  style.textContent =
    `:root { ${light.join(" ")} }\n` +
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark.join(" ")} } }\n` +
    `:root[data-theme="dark"] { ${dark.join(" ")} }\n`;
}

/* ---------------------------------------------------------------- *
 * Chrome (toolbar, legend, KPIs)
 * ---------------------------------------------------------------- */

/**
 * Everything here is wired once. Anything that depends on the *contents* of
 * data/events.json lives in applyData(), which runs again after a refresh.
 */
function buildChrome() {
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

  /* month nav — moving to another year moves the period control with it, so
     the two never contradict each other */
  const goToMonth = (anchor) => setState({ anchor, ...periodFollowing(anchor) });
  $("#nav-prev").addEventListener("click", () => goToMonth(addMonths(state.anchor, -1)));
  $("#nav-next").addEventListener("click", () => goToMonth(addMonths(state.anchor, 1)));
  $("#nav-today").addEventListener("click", () => goToMonth(startOfMonth(data.today)));

  /* period */
  const periodSelect = $("#period-select");
  periodSelect.addEventListener("change", () => setPeriod(periodSelect.value));

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

  /* unit filter (options are filled by applyData) */
  const unitSelect = $("#unit-filter");
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

  /* refresh */
  $("#refresh").addEventListener("click", refreshData);

  /* exports */
  $("#export-ics").addEventListener("click", () => {
    const events = visibleEvents();
    download(
      `bwd-pmt-calendar-${data.today}.ics`,
      toICS(events, data.calendar, data.categoryById),
      "text/calendar",
    );
    announceExport(events.length, "iCalendar file");
  });
  $("#export-csv").addEventListener("click", () => {
    const events = visibleEvents();
    download(`bwd-pmt-calendar-${data.today}.csv`, toCSV(events, data.categoryById), "text/csv");
    announceExport(events.length, "spreadsheet");
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

  initSwipe();
  syncControls();
}

/**
 * Month navigation by swipe, which on a phone is the only obvious way to move
 * between months. Horizontal intent has to beat vertical clearly, or every
 * scroll down the page would change the month.
 */
const SWIPE_MIN_PX = 55;
const SWIPE_RATIO = 1.4;

function initSwipe() {
  const view = $("#view");
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let swiped = false;

  view.addEventListener(
    "touchstart",
    (event) => {
      if (state.view !== "month" || event.touches.length !== 1) return;
      tracking = true;
      swiped = false;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    },
    { passive: true },
  );

  view.addEventListener(
    "touchend",
    (event) => {
      if (!tracking) return;
      tracking = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;

      swiped = true;
      const anchor = addMonths(state.anchor, dx < 0 ? 1 : -1);
      setState({ anchor, ...periodFollowing(anchor) });
    },
    { passive: true },
  );

  view.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });

  // A swipe that passed over an activity must not also open it. Capture phase,
  // so this runs before the delegate that opens the detail panel.
  view.addEventListener(
    "click",
    (event) => {
      if (!swiped) return;
      swiped = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}

/**
 * Renders everything that comes out of data/events.json. Called on boot and
 * again after a manual refresh, so it must be safe to run repeatedly.
 */
function applyData() {
  const { calendar } = data;
  injectCategoryColors();

  $("#calendar-name").textContent = calendar.name;
  $("#subscribe-link").href = calendar.googleUrl;
  $("#ics-link").href = calendar.icsUrl;
  $("#today-label").textContent = formatDay(data.today);
  syncGeneratedAt();

  /* unit filter options */
  const unitSelect = $("#unit-filter");
  unitSelect.innerHTML = `<option value="">All units</option>`;
  for (const unit of data.units) {
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = unit;
    unitSelect.append(option);
  }

  /* period options — one per year the cycle touches, plus the whole run */
  const periodSelect = $("#period-select");
  periodSelect.innerHTML = "";
  for (const year of yearsCovered(data.range)) {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    periodSelect.append(option);
  }
  const whole = document.createElement("option");
  whole.value = ALL_YEARS;
  whole.textContent = "Whole cycle";
  periodSelect.append(whole);

  /* legend, which doubles as the stage filter */
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
      `<span class="chip__label">${escapeHtml(category.label)}</span>` +
      `<span class="chip__count">${category.count}</span>`;
    chip.addEventListener("click", () => {
      const next = new Set(state.categories);
      if (next.has(category.id)) next.delete(category.id);
      else next.add(category.id);
      setState({ categories: next });
    });
    legend.append(chip);
  }
}

/**
 * When the month grid moves into a different year, follow it with the period
 * control — unless the whole cycle is on show, which is not a year to leave.
 */
function periodFollowing(anchor) {
  if (state.period === ALL_YEARS) return {};
  const year = anchor.slice(0, 4);
  if (year === state.period) return {};
  return yearsCovered(data.range).includes(year) ? { period: year } : {};
}

/** The first month of `year` that actually holds an activity. */
function firstMonthOf(year) {
  const inYear = data.events
    .filter((event) => event.end >= `${year}-01-01` && event.start <= `${year}-12-31`)
    .map((event) => (event.start < `${year}-01-01` ? `${year}-01-01` : event.start))
    .sort();
  return startOfMonth(inYear[0] ?? `${year}-01-01`);
}

function setPeriod(period) {
  const patch = { period };
  if (state.view === "month") {
    // Land the grid on a month that has something in it, rather than on a
    // blank January.
    patch.anchor =
      period === ALL_YEARS
        ? startOfMonth(
            data.today >= data.range.start && data.today <= data.range.end
              ? data.today
              : data.range.start,
          )
        : firstMonthOf(period);
  }
  setState(patch);
}

function syncGeneratedAt() {
  const stamp = new Date(data.generatedAt);
  const node = $("#generated-at");
  node.dateTime = data.generatedAt;
  node.textContent = stamp.toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: data.calendar.timeZone,
  });
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
  $("#period-select").value = state.period;
  // In the month grid the select supplies the year, so the label names only
  // the month; in the other views the select says it all.
  $("#period-label").hidden = state.view !== "month";
  $("#period-label").textContent =
    state.view === "month" ? MONTHS[Number(state.anchor.slice(5, 7)) - 1] : "";

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
 * Manual refresh
 *
 * The page can only re-read data/events.json: Google's iCalendar endpoint
 * sends no CORS headers, so the browser cannot reach the feed itself. The
 * scheduled workflow is what pulls Google -> events.json; this button picks up
 * a newer snapshot without a full page reload, and reports honestly when the
 * snapshot has not moved.
 * ---------------------------------------------------------------- */

/** Cheap fingerprint of the schedule — enough to tell "changed" from "same". */
function signatureOf(payload) {
  return [
    payload.generatedAt,
    payload.events.length,
    ...payload.events.map((event) => `${event.id}:${event.start}:${event.end}:${event.title}`),
  ].join("|");
}

async function refreshData() {
  if (refreshing) return;
  refreshing = true;

  const button = $("#refresh");
  button.disabled = true;
  button.classList.add("is-busy");

  try {
    const fresh = await loadCalendar({ bust: true });
    const signature = signatureOf(fresh);
    const changed = signature !== lastSignature;
    const before = data.events.length;

    data = fresh;
    lastSignature = signature;

    // A stage or unit that vanished from the feed must not keep filtering the
    // view to nothing — drop those selections rather than stranding the user.
    const categories = new Set(data.categories.map((category) => category.id));
    const units = new Set(data.units);
    const keptCategories = new Set([...state.categories].filter((id) => categories.has(id)));
    const keptUnits = new Set([...state.units].filter((unit) => units.has(unit)));

    drawer.close();
    drawer.update({
      calendar: data.calendar,
      categoryById: data.categoryById,
      today: data.today,
    });

    state = { ...state, categories: keptCategories, units: keptUnits };
    applyData();
    syncControls();
    render();

    if (fresh.fromCache) {
      toast(
        "Showing the saved copy",
        "The network could not be reached, so this is the schedule stored on this device.",
        "error",
      );
    } else if (!changed) {
      toast("Already up to date", "The published schedule has not changed since it was last read.");
    } else {
      const delta = data.events.length - before;
      const detail =
        delta === 0
          ? "Activity details were updated."
          : delta > 0
            ? `${delta} ${delta === 1 ? "activity" : "activities"} added.`
            : `${-delta} ${delta === -1 ? "activity" : "activities"} removed.`;
      toast("Schedule updated", detail);
    }
  } catch (error) {
    toast("Could not refresh", `${error.message}. The schedule on screen is unchanged.`, "error");
  } finally {
    refreshing = false;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

/**
 * An export carries what is on screen, which the period selector narrows — so
 * say how many activities went into the file rather than letting someone
 * assume they exported the whole cycle.
 */
function announceExport(count, kind) {
  const scope =
    state.period === ALL_YEARS ? "the whole cycle" : `${state.period}`;
  toast(
    `${count} ${count === 1 ? "activity" : "activities"} exported`,
    `The ${kind} holds what is currently in view (${scope}).`,
  );
}

let toastTimer = null;

function toast(title, detail, tone = "info") {
  const host = $("#toast");
  host.innerHTML =
    `<span class="toast__title">${escapeHtml(title)}</span>` +
    `<span class="toast__detail">${escapeHtml(detail)}</span>`;
  host.className = `toast toast--${tone}`;
  host.hidden = false;
  void host.offsetWidth; // start the transition from the closed state
  host.classList.add("is-open");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.classList.remove("is-open");
  }, 5200);
}

/* ---------------------------------------------------------------- *
 * Render
 * ---------------------------------------------------------------- */

function visibleEvents() {
  return filterEvents(data.events, {
    query: state.query,
    year: state.period,
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
    const inOtherYears =
      state.period === ALL_YEARS
        ? 0
        : filterEvents(data.events, {
            query: state.query,
            categories: state.categories,
            units: state.units,
            lifecycles: state.lifecycles,
          }).length;

    container.innerHTML =
      `<div class="notice"><h2>Nothing to show here</h2>` +
      `<p>${
        inOtherYears
          ? `Nothing matches in ${escapeHtml(state.period)}, but ${inOtherYears} ` +
            `${inOtherYears === 1 ? "activity matches" : "activities match"} elsewhere in the cycle.`
          : "Try clearing the search box or re-enabling an SPMS stage in the legend below."
      }</p>` +
      `<div class="notice__actions">${
        inOtherYears
          ? `<button type="button" class="btn btn--primary" id="empty-widen">Show the whole cycle</button>`
          : ""
      }<button type="button" class="btn" id="empty-reset">Clear all filters</button></div></div>`;

    $("#empty-widen")?.addEventListener("click", () => setPeriod(ALL_YEARS));
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
