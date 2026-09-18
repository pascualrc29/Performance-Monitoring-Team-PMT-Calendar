/**
 * Install and offline support.
 *
 * Registers the service worker, offers the install prompt where the browser
 * provides one, and falls back to instructions on iOS, where Safari has no
 * beforeinstallprompt and the only route is Share → Add to Home Screen.
 */

const IOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const STANDALONE =
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let deferredPrompt = null;

export function initPWA({ onUpdate, onMessage } = {}) {
  registerWorker(onUpdate);

  const button = document.getElementById("install");
  if (!button) return;

  // Already installed, or running as the installed app: nothing to offer.
  if (STANDALONE) return;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chromium would otherwise show its own mini-infobar; we want the prompt
    // to fire from a button the viewer chose to press.
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    button.hidden = true;
    onMessage?.("Installed", "The PMT Calendar is now on your home screen.");
  });

  if (IOS) {
    button.hidden = false;
    button.addEventListener("click", () => {
      onMessage?.(
        "Add to Home Screen",
        "Tap the Share button in Safari, then choose “Add to Home Screen”.",
      );
    });
    return;
  }

  button.addEventListener("click", async () => {
    if (!deferredPrompt) {
      onMessage?.(
        "Install from your browser menu",
        "Look for “Install” or “Add to Home Screen” in the browser menu.",
      );
      return;
    }
    button.disabled = true;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    button.disabled = false;
    if (outcome === "accepted") button.hidden = true;
  });
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
