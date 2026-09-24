/**
 * Activity detail drawer: a modal side panel with a focus trap, Escape to
 * close, and per-activity export links.
 */

import {
  formatDay, formatDuration, formatRange, formatTime, relativeLabel, spanDays,
} from "./dates.js";
import { download, googleAddUrl, LIFECYCLE_LABEL, stageStyle, toICS } from "./store.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function createDetailDrawer({ root, calendar, categoryById, today, onClose }) {
  let lastFocused = null;
  let currentEvent = null;
  let context = { calendar, categoryById, today };

  const backdrop = document.createElement("div");
  backdrop.className = "drawer__backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("aside");
  panel.className = "drawer";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "drawer-title");
  panel.hidden = true;

  root.append(backdrop, panel);

  backdrop.addEventListener("click", close);

  panel.addEventListener("keydown", (mouseEvent) => {
    if (mouseEvent.key === "Escape") {
      mouseEvent.stopPropagation();
      close();
      return;
    }
    if (mouseEvent.key !== "Tab") return;
    const nodes = [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes.at(-1);
    if (mouseEvent.shiftKey && document.activeElement === first) {
      mouseEvent.preventDefault();
      last.focus();
    } else if (!mouseEvent.shiftKey && document.activeElement === last) {
      mouseEvent.preventDefault();
      first.focus();
    }
  });

  function open(event) {
    currentEvent = event;
    lastFocused = document.activeElement;
    panel.innerHTML = template(event, context);
    panel.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("has-drawer");
    requestAnimationFrame(() => {
      panel.classList.add("is-open");
      backdrop.classList.add("is-open");
      panel.querySelector("[data-drawer-close]")?.focus();
    });

    panel.querySelector("[data-drawer-close]")?.addEventListener("click", close);
    panel.querySelector("[data-download-ics]")?.addEventListener("click", () => {
      download(
        `${slug(event.title)}.ics`,
        toICS([event], context.calendar, context.categoryById),
        "text/calendar",
      );
    });
  }

  function close() {
    if (panel.hidden) return;
    panel.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    currentEvent = null;
    document.body.classList.remove("has-drawer");
    const finish = () => {
      panel.hidden = true;
      backdrop.hidden = true;
      panel.innerHTML = "";
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else setTimeout(finish, 180);
    lastFocused?.focus?.();
    onClose?.();
  }

  /** Point the drawer at a freshly loaded schedule without rebuilding it. */
  function update(next) {
    context = { ...context, ...next };
  }

  return {
    open,
    close,
    update,
    get isOpen() { return !panel.hidden; },
    get event() { return currentEvent; },
  };
}

function template(event, { calendar, categoryById, today }) {
  const category = categoryById.get(event.category);
  const timeline =
    event.lifecycle === "done"
      ? `Ended ${relativeLabel(event.end, today)}`
      : event.lifecycle === "active"
        ? `Day ${Math.max(1, spanDays(event.start, today))} of ${event.durationDays}`
        : `Starts ${relativeLabel(event.start, today)}`;

  const facts = [
    ["Schedule", escapeHtml(formatRange(event.start, event.end))],
    !event.allDay && event.startTime
      ? ["Time", `${formatTime(event.startTime)} – ${formatTime(event.endTime)} (${calendar.timeZone.split("/")[1]})`]
      : null,
    ["Duration", escapeHtml(formatDuration(event)) + (event.session ? ` (${event.session} session)` : "")],
    ["SPMS stage", escapeHtml(category?.label ?? "Other")],
    event.output ? ["Expected output", escapeHtml(event.output)] : null,
  ].filter(Boolean);

  return `
    <header class="drawer__head" style="${stageStyle(event.category)}">
      <div class="drawer__head-row">
        <span class="tag tag--series">${escapeHtml(category?.short ?? "Other")}</span>
        <button type="button" class="iconbtn" data-drawer-close aria-label="Close activity details">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
        </button>
      </div>
      <h2 id="drawer-title" class="drawer__title">${escapeHtml(event.title)}</h2>
      <p class="drawer__sub">
        <span class="pill pill--${event.lifecycle}">${LIFECYCLE_LABEL[event.lifecycle]}</span>
        <span>${escapeHtml(timeline)}</span>
      </p>
      ${
        event.lifecycle === "active"
          ? `<div class="drawer__progress" role="img" aria-label="${Math.round(event.progress * 100)} percent elapsed">
               <span style="width: ${Math.round(event.progress * 100)}%"></span>
             </div>`
          : ""
      }
    </header>

    <div class="drawer__body">
      <dl class="facts">
        ${facts
          .map(([term, value]) => `<div class="facts__row"><dt>${term}</dt><dd>${value}</dd></div>`)
          .join("")}
      </dl>

      ${
        event.responsible.length
          ? `<section class="drawer__section">
               <h3>Unit / person responsible</h3>
               <ul class="chiplist">
                 ${event.responsible.map((unit) => `<li class="tag">${escapeHtml(unit)}</li>`).join("")}
               </ul>
             </section>`
          : ""
      }

      ${
        event.notes.length
          ? `<section class="drawer__section">
               <h3>Agenda / notes</h3>
               <ul class="notelist">
                 ${event.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
               </ul>
             </section>`
          : ""
      }

      <section class="drawer__section">
        <h3>Add to your own calendar</h3>
        <div class="drawer__actions">
          <a class="btn btn--primary" href="${googleAddUrl(event, calendar)}" target="_blank" rel="noopener noreferrer">
            Google Calendar
            <svg viewBox="0 0 20 20" aria-hidden="true" class="btn__icon"><path d="M7 3h10v10M17 3L6 14" /></svg>
          </a>
          <button type="button" class="btn" data-download-ics>Download .ics</button>
        </div>
      </section>

      <footer class="drawer__foot">
        ${
          event.updated
            ? `Calendar entry last updated ${escapeHtml(formatDay(event.updated.slice(0, 10)))}.`
            : ""
        }
      </footer>
    </div>
  `;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
  );
}
