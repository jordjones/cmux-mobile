/**
 * feedback — the single surface for connection state + transient notices, so
 * every reconnect/error/resync item renders through one place instead of each
 * inventing its own overlay.
 *
 * - a banner under the header (tappable only while disconnected → retry),
 * - a non-interactive toast stack (pointer-events:none, never steals taps),
 * - a `.reconnecting` dim on #screen, applied only after a short grace so brief
 *   blips don't flicker (a separate `.desync` class, owned by app.ts, marks a
 *   persistent checksum divergence — a different, actionable state).
 */
export type ConnState = "open" | "connecting" | "closed";

/** Don't dim the screen for sub-second reconnects — only once we've been down this long. */
const RECONNECT_GRACE_MS = 2000;

let bannerEl: HTMLElement | null = null;
let toastHostEl: HTMLElement | null = null;
let screenEl: HTMLElement | null = null;
let onRetry: (() => void) | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;

export function initFeedback(opts: {
  banner: HTMLElement;
  toastHost: HTMLElement;
  screen: HTMLElement;
  onRetry: () => void;
}): void {
  bannerEl = opts.banner;
  toastHostEl = opts.toastHost;
  screenEl = opts.screen;
  onRetry = opts.onRetry;
  bannerEl.addEventListener("click", () => {
    if (bannerEl?.dataset.state === "closed") onRetry?.();
  });
}

export function setConnState(state: ConnState, text?: string): void {
  if (bannerEl) {
    bannerEl.dataset.state = state;
    if (state === "open") {
      bannerEl.hidden = true;
      bannerEl.textContent = "";
    } else {
      bannerEl.hidden = false;
      bannerEl.textContent =
        text ?? (state === "connecting" ? "Reconnecting…" : "Disconnected — tap to retry");
    }
  }
  // Dim only after a grace window so a fast reconnect never flashes the screen.
  if (state === "open") {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    screenEl?.classList.remove("reconnecting");
  } else if (!graceTimer && !screenEl?.classList.contains("reconnecting")) {
    graceTimer = setTimeout(() => {
      graceTimer = null;
      screenEl?.classList.add("reconnecting");
    }, RECONNECT_GRACE_MS);
  }
}

let lastToastText = "";
let lastToastEl: HTMLElement | null = null;

export function toast(text: string, ms = 2500): void {
  if (!toastHostEl) return;
  // De-dupe a still-visible identical toast.
  if (text === lastToastText && lastToastEl?.isConnected) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastHostEl.appendChild(el);
  lastToastText = text;
  lastToastEl = el;
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  }, ms);
}
