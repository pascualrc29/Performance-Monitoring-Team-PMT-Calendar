/**
 * Install and offline support.
 *
 * Registers the service worker, offers the install prompt where the browser
 * provides one, and falls back to instructions on iOS, where Safari has no
 * beforeinstallprompt and the only route is Share → Add to Home Screen.
 */

const UA = navigator.userAgent;

/* iPadOS 13 and later report a *Mac* user agent by default — "Request Desktop
   Website" is on out of the box — so an iPad does not match /ipad/ and used to
   fall through to the Chromium branch, where beforeinstallprompt never fires
   and the offer therefore never appeared at all. Real Macs report
   maxTouchPoints 0, so the touch count is what separates the two. */
const IOS =
  /iphone|ipad|ipod/i.test(UA) || (/macintosh/i.test(UA) && navigator.maxTouchPoints > 1);

/* Safari on macOS has no beforeinstallprompt either. Its route is File → Add
   to Dock (Safari 17+). Chromium-based browsers also carry "Safari" in their
   user agent, so they have to be excluded by name. */
const MAC_SAFARI =
  !IOS && /macintosh/i.test(UA) && /safari/i.test(UA) && !/chrome|chromium|edg\//i.test(UA);

/* Firefox on Android installs from its own menu and fires no
   beforeinstallprompt. Desktop Firefox cannot install at all, so the two must
   not be treated alike. */
const ANDROID_FIREFOX = /android/i.test(UA) && /firefox/i.test(UA);

/** True where the browser gives us no install API but the viewer can still
 *  install by hand, so the dialog shows the menu path instead of a button. */
const MANUAL_ONLY = IOS || MAC_SAFARI || ANDROID_FIREFOX;
const STANDALONE =
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const SNOOZE_KEY = "bwd-pmt-install-dismissed";
/** How long "Not now" lasts. Long enough not to nag, short enough to catch a
 *  viewer who has since decided they use this every day. */
const SNOOZE_DAYS = 30;
/** Let the calendar paint first: a dialog over a blank page reads as an
 *  interstitial ad rather than an offer about the thing you came for. */
const OPEN_DELAY_MS = 1400;

let deferredPrompt = null;

export function initPWA({ onUpdate, onMessage } = {}) {
  registerWorker(onUpdate);

  const button = document.getElementById("install");
  if (!button) return;

  // Already installed, or running as the installed app: nothing to offer, and
  // above all no dialog. Every listener below sits behind this check.
  if (STANDALONE) return;

  const dialog = createInstallDialog(() => install(onMessage));

  // The inline script in index.html may already hold an event that fired
  // before this module was evaluated.
  if (window.__installEvent) {
    deferredPrompt = window.__installEvent;
    button.hidden = false;
    dialog.offerLater();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chromium would otherwise show its own mini-infobar; we want the prompt
    // to fire from a button the viewer chose to press.
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
    dialog.offerLater();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    button.hidden = true;
    dialog.close();
    remember();
    onMessage?.("Installed", "The PMT Calendar is now on your home screen.");
  });

  // Safari fires no beforeinstallprompt, so there the offer cannot wait on an
  // event that never comes.
  if (MANUAL_ONLY) {
    button.hidden = false;
    button.addEventListener("click", () => {
      onMessage?.(...manualHint());
    });
    dialog.offerLater();
    return;
  }

  button.addEventListener("click", () => install(onMessage, button));
}

/** Shared by the header button and the dialog, because the deferred event is
 *  single-use: whichever surface prompts, the other must stop offering. */
async function install(onMessage, button) {
  if (!deferredPrompt) {
    onMessage?.(
      "Install from your browser menu",
      "Look for “Install” or “Add to Home Screen” in the browser menu.",
    );
    return "unavailable";
  }
  if (button) button.disabled = true;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (button) {
    button.disabled = false;
    if (outcome === "accepted") button.hidden = true;
  }
  return outcome;
}

/* ---------------------------------------------------------------- *
 * The centred offer
 * ---------------------------------------------------------------- */

/** The menu path for a browser with no install API, as dialog steps. */
function manualSteps() {
  if (IOS) {
    return (
      "<li>Tap <b>Share</b> in Safari.</li>" +
      "<li>Choose <b>Add to Home Screen</b>.</li>" +
      "<li>Tap <b>Add</b>.</li>"
    );
  }
  if (ANDROID_FIREFOX) {
    return (
      "<li>Tap <b>\u22EE</b> at the top right of Firefox.</li>" +
      "<li>Choose <b>Install</b> \u2014 older versions say <b>Add to Home screen</b>.</li>" +
      "<li>Tap <b>Add</b>.</li>"
    );
  }
  return (
    "<li>Open the <b>File</b> menu in Safari.</li>" +
    "<li>Choose <b>Add to Dock</b>.</li>" +
    "<li>Click <b>Add</b>.</li>"
  );
}

/** The same path, condensed for the header button's toast. */
function manualHint() {
  if (IOS) {
    return ["Add to Home Screen", "Tap Share in Safari, then choose \u201CAdd to Home Screen\u201D."];
  }
  if (ANDROID_FIREFOX) {
    return ["Install this site", "Open Firefox\u2019s \u22EE menu and choose Install."];
  }
  return ["Add to Dock", "In Safari\u2019s menu bar choose File \u2192 Add to Dock."];
}

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    // A private window can refuse storage. Erring toward not showing is the
    // kinder failure: a viewer who cannot be remembered would otherwise meet
    // this dialog on every single visit.
    return true;
  }
}

function remember() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 864e5));
  } catch {
    // Nothing to do; the dialog reappears next visit.
  }
}

function createInstallDialog(onInstall) {
  let root = null;
  let opener = null;
  let timer = null;

  const phone = window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;

  function build() {
    const backdrop = document.createElement("div");
    backdrop.className = "installer__backdrop";

    const panel = document.createElement("div");
    panel.className = "installer";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "installer-title");
    // Focus lands on the panel, not on a button: on Install an accidental
    // Enter would install, on the close button it would dismiss. Neither
    // should be a keypress away from a viewer who has not read it yet.
    panel.tabIndex = -1;

    panel.innerHTML =
      '<button class="installer__close" type="button" data-close aria-label="Close">' +
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg></button>' +
      '<img class="installer__mark" src="assets/img/icon-192.png" alt="" width="58" height="58" />' +
      '<h2 class="installer__title" id="installer-title">Install the PMT Calendar</h2>' +
      '<p class="installer__lede">Keep the Performance Monitoring Team schedule ' +
      (phone ? 'on your home screen' : 'on your desktop') +
      ' \u2014 it opens like an app and still works without a connection.</p>' +
      (MANUAL_ONLY
        ? '<ol class="installer__steps">' +
          manualSteps() +
          '</ol><div class="installer__actions">' +
          '<button class="btn btn--primary" type="button" data-close>Got it</button></div>'
        : '<div class="installer__actions">' +
          '<button class="btn btn--primary" type="button" data-install>Install</button>' +
          '<button class="btn btn--quiet" type="button" data-close>Not now</button></div>') +
      '<p class="installer__foot">You can install later from the button in the header.</p>';

    backdrop.addEventListener("click", close);
    panel.addEventListener("click", (event) => {
      if (event.target.closest("[data-close]")) close();
      else if (event.target.closest("[data-install]")) accept();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;
      // Focus trap: the dialog is modal, so Tab must not walk the page behind.
      const stops = [...panel.querySelectorAll("button")];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    document.body.append(backdrop, panel);
    return { backdrop, panel };
  }

  function open() {
    if (root || STANDALONE || snoozed()) return;
    root = build();
    opener = document.activeElement;
    document.body.classList.add("has-installer");
    requestAnimationFrame(() => {
      root.backdrop.classList.add("is-open");
      root.panel.classList.add("is-open");
      root.panel.focus();
    });
  }

  function close() {
    clearTimeout(timer);
    if (!root) return;
    // Closing is a decision either way, so honour it for SNOOZE_DAYS rather
    // than asking again on the next page load.
    remember();
    const going = root;
    root = null;
    going.backdrop.classList.remove("is-open");
    going.panel.classList.remove("is-open");
    document.body.classList.remove("has-installer");
    setTimeout(() => {
      going.backdrop.remove();
      going.panel.remove();
    }, 200);
    opener?.focus?.();
  }

  async function accept() {
    await onInstall();
    close();
  }

  function offerLater() {
    if (root || STANDALONE || snoozed()) return;
    clearTimeout(timer);
    timer = setTimeout(open, OPEN_DELAY_MS);
  }

  return { offerLater, open, close };
}

function registerWorker(onUpdate) {
  if (!("serviceWorker" in navigator)) return;
  // A service worker needs a secure context; over plain http it only works on
  // localhost, so skip it rather than throwing during local development.
  if (!window.isSecureContext) return;

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");

      registration.addEventListener("updatefound", () => {
        const incoming = registration.installing;
        if (!incoming) return;
        incoming.addEventListener("statechange", () => {
          // A worker that reaches "installed" while one is already in control
          // is a new version waiting for the page to hand over.
          if (incoming.state === "installed" && navigator.serviceWorker.controller) {
            onUpdate?.(() => incoming.postMessage("skip-waiting"));
          }
        });
      });
    } catch {
      // No offline support this visit; the site still works online.
    }
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
