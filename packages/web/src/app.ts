/**
 * app — wires transport + screen model + terminal view + picker into the PWA.
 * M1: list surfaces, subscribe to one, render its live (monochrome) mirror.
 * Input (M2) is layered on top of this.
 */
import type { ServerMessage } from "@cmux-mobile/protocol";
import { Transport } from "./transport.ts";
import { ScreenModel } from "./screen-model.ts";
import { TerminalView } from "./terminal-view.ts";
import { Picker } from "./picker.ts";
import { InputController } from "./input.ts";
import { initFeedback, setConnState, toast } from "./feedback.ts";
import { detectShortcuts } from "./shortcuts-detect.ts";

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

const TOKEN_KEY = "cmux_token";
const MRU_KEY = "cmux_mru";
const MRU_CAP = 5;
const RETURN_SENDS_KEY = "cmux_return_sends";
const WRAP_KEY = "cmux_wrap";

/** Most-recently-used surface ids, newest first (localStorage-backed). */
function loadMru(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
function saveMru(ids: string[]): void {
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify(ids.slice(0, MRU_CAP)));
  } catch {
    /* storage may be unavailable */
  }
}
function pushMru(id: string): void {
  saveMru([id, ...loadMru().filter((x) => x !== id)]);
}
function dropMru(id: string): void {
  saveMru(loadMru().filter((x) => x !== id));
}
function pruneMru(present: Set<string>): void {
  saveMru(loadMru().filter((x) => present.has(x)));
}
function mruFront(present: Set<string>): string | undefined {
  return loadMru().find((x) => present.has(x));
}

const FONT_KEY = "cmux_font";
const FONT_MIN = 10;
const FONT_MAX = 22;
/** Seed the terminal font from iOS Dynamic Type (root rem reflects the user's base size). */
function seedFont(): number {
  const base = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(12 * (base / 16))));
}
function loadFont(): number {
  const v = Number(localStorage.getItem(FONT_KEY));
  return v >= FONT_MIN && v <= FONT_MAX ? v : seedFont();
}
function applyFont(px: number): void {
  document.documentElement.style.setProperty("--term-font-size", `${px}px`);
}

/** Token may arrive once in the URL fragment (#token=…); persist + scrub it. */
function getToken(): string {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromHash = hash.get("token");
  if (fromHash) {
    localStorage.setItem(TOKEN_KEY, fromHash);
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  return "browser";
}

function setupPairing(): void {
  const code = el<HTMLInputElement>("paircode");
  const msg = el("pairmsg");
  const submit = async (): Promise<void> => {
    if (!/^\d{6}$/.test(code.value.trim())) {
      msg.textContent = "Enter the 6-digit code.";
      return;
    }
    msg.textContent = "Pairing…";
    try {
      const res = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.value.trim(), name: deviceName() }),
      });
      if (!res.ok) {
        msg.textContent = "Invalid or expired code.";
        return;
      }
      const { token } = (await res.json()) as { token: string };
      localStorage.setItem(TOKEN_KEY, token);
      location.reload();
    } catch {
      msg.textContent = "Pairing failed — is the bridge reachable?";
    }
  };
  el("pairgo").addEventListener("click", () => void submit());
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
}

/**
 * Keep the layout sized to the *visible* area above the on-screen keyboard.
 * iOS overlays the software keyboard without resizing the layout viewport, so
 * `100dvh` leaves the footer + bottom rows hidden behind it; visualViewport
 * gives us the real height/offset.
 */
function trackKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = (): void => {
    document.body.style.height = `${vv.height}px`;
    // When the page is pinned-scrolled by the keyboard, offset back to the top.
    document.body.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
    // Keyboard up (viewport shrank a lot) → collapse the dynamic shortcut bar to
    // reclaim a terminal row. Ratio + hysteresis (set >25%, clear <12%) so it
    // doesn't flicker mid-animation or misfire on small devices.
    const shrunk = (window.innerHeight - vv.height) / (window.innerHeight || 1);
    const up = document.body.classList.contains("kb-up") ? shrunk > 0.12 : shrunk > 0.25;
    document.body.classList.toggle("kb-up", up);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

function main(): void {
  const statusEl = el("status");
  const titleWorkspaceEl = el("title-workspace");
  const titleTabEl = el("title-tab");
  const screenEl = el("screen");
  const pickerEl = el("picker");
  const autokeysEl = el("autokeys");
  const shortcutInd = el("shortcut-ind");
  const cliphint = el("cliphint");
  applyFont(loadFont()); // before any render so the grid is sized correctly

  const token = getToken();
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const transport = new Transport(`${wsProto}://${location.host}/ws`, token);

  const view = new TerminalView(screenEl);
  // History (scrollback) view: a one-shot snapshot rendered above the live tail.
  // While viewing it, live frames keep updating the model but don't repaint the
  // screen (so the snapshot doesn't jump); scrolling back to the bottom resumes live.
  const HISTORY_LINES = 1000;
  let historyMode = false;
  let loadingHistory = false;
  // While the user has an active text selection inside the terminal, hold off
  // repainting — the 15 Hz row rewrite would otherwise collapse the selection
  // mid-gesture (the "selection feels sluggish" report). Repaint once it clears.
  let selecting = false;
  const model = new ScreenModel((u) => {
    if (historyMode || selecting) return;
    u.full ? view.render(u.rows) : view.applyDirty(u.rows, u.dirty ?? []);
    refreshAutokeys();
    updateClipHint();
  });

  // Dynamic shortcut bar: surface key hints printed in the live terminal
  // (shift+tab, ctrl+o, esc to interrupt, …) as tappable keys. On by default;
  // set localStorage cmux_autokeys="off" to disable. Only repaints on change.
  const autokeysOn = localStorage.getItem("cmux_autokeys") !== "off";
  let lastAutokeysSig = "";
  function refreshAutokeys(): void {
    if (!autokeysOn) return;
    const detected = detectShortcuts(model.rows);
    shortcutInd.classList.toggle("active", detected.length > 0); // dim ↔ accent
    const sig = detected.map((d) => d.key).join(",");
    if (sig === lastAutokeysSig) return;
    lastAutokeysSig = sig;
    autokeysEl.replaceChildren();
    if (detected.length === 0) {
      autokeysEl.hidden = true;
      return;
    }
    for (const d of detected) {
      const b = document.createElement("button");
      b.dataset.key = d.key;
      b.textContent = d.label;
      b.setAttribute("aria-label", `Send ${d.key}`);
      autokeysEl.appendChild(b);
    }
    autokeysEl.hidden = false;
  }
  const picker = new Picker(el("picker-list"), (surfaceId) => selectSurface(surfaceId));
  const scrimEl = el("picker-scrim");

  function openPicker(): void {
    pickerEl.classList.add("open");
    pickerEl.toggleAttribute("inert", false);
    scrimEl.hidden = false;
    // Note: do NOT autofocus the search field — that summons the keyboard on a
    // plain navigation tap (☰). The user taps the search box only if they want it.
  }
  function closePicker(): void {
    pickerEl.classList.remove("open");
    pickerEl.toggleAttribute("inert", true);
    scrimEl.hidden = true;
  }
  const composeInput = el<HTMLTextAreaElement>("compose-input");
  const input = new InputController(
    composeInput,
    (m) => {
      if (!transport.send(m)) toast("Buffering input — connection lost");
    },
    () => refreshHistBtn(),
  );

  let lastSurfaces: import("@cmux-mobile/protocol").SurfaceInfo[] = [];
  let lastResyncAt = 0;
  let consecutiveResync = 0;
  let attention = new Set<string>(); // surfaces waiting for input (picker dots)
  function renderPicker(): void {
    picker.render(lastSurfaces, model.surfaceId, attention);
  }

  function selectSurface(surfaceId: string): void {
    if (model.surfaceId === surfaceId) return;
    historyMode = false; // leave any history view when changing panes
    loadingHistory = false;
    if (model.surfaceId) transport.send({ t: "unsubscribe", surfaceId: model.surfaceId });
    model.setSurface(surfaceId);
    input.setSurface(surfaceId);
    consecutiveResync = 0;
    const info = lastSurfaces.find((s) => s.surfaceId === surfaceId);
    titleWorkspaceEl.textContent = info?.workspaceTitle?.trim() || "";
    titleTabEl.textContent = info?.title?.trim() || info?.surfaceRef || "—";
    transport.send({ t: "subscribe", surfaceId });
    pushMru(surfaceId);
    renderPicker();
    closePicker();
  }

  initFeedback({
    banner: el("banner"),
    toastHost: el("toasts"),
    screen: screenEl,
    onRetry: () => transport.reconnectNow(),
  });

  let connOpen = false;
  transport.onStatus((s) => {
    connOpen = s === "open";
    statusEl.textContent = s;
    statusEl.dataset.state = s;
    setConnState(s);
  });

  setupPairing();
  trackKeyboard();
  transport.onAuthNeeded(() => {
    el("pair").hidden = false;
  });

  transport.onMessage((msg: ServerMessage) => {
    switch (msg.t) {
      case "topology": {
        lastSurfaces = msg.surfaces;
        const present = new Set(msg.surfaces.map((s) => s.surfaceId));
        pruneMru(present);
        renderPicker();
        if (!model.surfaceId) {
          // First load: restore the most-recent surface if still present, else the first.
          const pick = mruFront(present) ?? msg.surfaces[0]?.surfaceId;
          if (pick) selectSurface(pick);
        } else if (present.has(model.surfaceId)) {
          // Reconnect: the bridge has a fresh empty mirror map, so re-subscribe
          // the active surface and force a fresh full frame. armFull() (not
          // setSurface) keeps the last frame on screen — no blank flash — until
          // the resync's full lands.
          const id = model.surfaceId;
          model.armFull();
          transport.send({ t: "subscribe", surfaceId: id });
          transport.flushPending(); // deliver keystrokes buffered during the outage
        } else {
          // The active surface was closed/removed (pane closed or cmux restart).
          const gone = model.surfaceId;
          dropMru(gone);
          toast("This pane closed");
          const next = mruFront(present) ?? msg.surfaces[0]?.surfaceId;
          if (next) {
            selectSurface(next); // unsubscribes the gone surface, subscribes next
          } else {
            transport.send({ t: "unsubscribe", surfaceId: gone });
            model.setSurface("");
            input.setSurface(null);
            titleWorkspaceEl.textContent = "";
            titleTabEl.textContent = "—";
            openPicker();
          }
        }
        return;
      }
      case "screen.full":
      case "screen.diff":
      case "screen.checksum": {
        const needResync = model.apply(msg);
        if (msg.t === "screen.full") {
          consecutiveResync = 0; // fresh authoritative frame — in sync again
          screenEl.classList.remove("desync");
        }
        if (needResync && model.surfaceId) {
          if (consecutiveResync >= 3) {
            // Persistent divergence: stop the 5s resync storm and surface it.
            screenEl.classList.add("desync");
            toast("Display out of sync — tap ⟳ to refresh");
          } else if (performance.now() - lastResyncAt > 3000) {
            lastResyncAt = performance.now();
            consecutiveResync++;
            model.armFull(); // ignore further diffs until the resync's full lands
            transport.send({ t: "resync", surfaceId: model.surfaceId });
          }
        }
        return;
      }
      case "scrollback": {
        loadingHistory = false;
        if (msg.surfaceId !== model.surfaceId) return;
        const before = screenEl.scrollHeight;
        historyMode = true;
        view.render(msg.rows);
        // Anchor: keep the lines the user was looking at in place so they can scroll further up.
        screenEl.scrollTop = Math.max(0, screenEl.scrollHeight - before);
        toast(`History — ${msg.rows.length} lines · scroll to bottom for live`);
        return;
      }
      case "activity": {
        attention = new Set(msg.attention);
        renderPicker();
        return;
      }
      case "error": {
        // Input failures are user-facing; mirror/connection errors stay in the console
        // (the connection banner already covers those).
        const human: Record<string, string> = {
          input_disabled: "Input not enabled",
          input_failed: "Couldn't send — pane unavailable",
          input_queue_full: "Sending too fast — paused",
        };
        const text = human[msg.code];
        if (text) toast(text);
        else console.warn("bridge error:", msg.code, msg.message);
        return;
      }
    }
  });

  // Surface picker open/close — scrim, ✕, and Escape all route through closePicker.
  // Title area also acts as a tap target (mirrors ☰) for natural "tap to switch" gesture.
  el("menu").addEventListener("click", () =>
    pickerEl.classList.contains("open") ? closePicker() : openPicker(),
  );
  el("title").addEventListener("click", () =>
    pickerEl.classList.contains("open") ? closePicker() : openPicker(),
  );
  scrimEl.addEventListener("click", () => closePicker());
  el("picker-close").addEventListener("click", () => closePicker());
  el<HTMLInputElement>("picker-search").addEventListener("input", (e) =>
    picker.setFilter((e.target as HTMLInputElement).value),
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pickerEl.classList.contains("open")) closePicker();
  });
  el("refresh").addEventListener("click", () => transport.send({ t: "list" }));

  // Tap the title to copy "WORKSPACE / tab" — share exactly which surface you're on
  // without opening the picker (the title has a pointer cursor + :active state).
  el("title").addEventListener("click", async () => {
    const label = [titleWorkspaceEl.textContent, titleTabEl.textContent].filter((s) => s && s.trim()).join(" / ");
    if (!label) return;
    try {
      await navigator.clipboard.writeText(label);
      toast(`Copied: ${label}`);
    } catch {
      toast("Clipboard blocked");
    }
  });

  // Font-size stepper — persists, and keeps the tail pinned across the resize.
  function stepFont(delta: number): void {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, loadFont() + delta));
    const pinned = screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 10;
    localStorage.setItem(FONT_KEY, String(next));
    applyFont(next);
    // Re-pin after the new font size has reflowed (scrollHeight changes a frame later).
    if (pinned) requestAnimationFrame(() => (screenEl.scrollTop = screenEl.scrollHeight));
    requestAnimationFrame(updateClipHint);
  }
  el("font-dec").addEventListener("click", () => stepFont(-1));
  el("font-inc").addEventListener("click", () => stepFont(1));

  // Scrollback: scrolling to the very top of a scrollable view loads history;
  // scrolling back to the bottom returns to the live tail.
  function loadHistory(): void {
    if (historyMode || loadingHistory || !model.surfaceId) return;
    loadingHistory = true;
    transport.send({ t: "scrollback", surfaceId: model.surfaceId, lines: HISTORY_LINES });
  }
  screenEl.addEventListener("scroll", () => {
    updateClipHint();
    if (historyMode) {
      if (screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 4) {
        historyMode = false;
        view.render(model.rows); // back to the live tail
        screenEl.scrollTop = screenEl.scrollHeight;
      }
    } else if (screenEl.scrollTop <= 0 && screenEl.scrollHeight > screenEl.clientHeight + 4) {
      loadHistory();
    }
  });

  // Hold repaints while a terminal selection is active; repaint the latest once it clears.
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    const active =
      !!sel && !sel.isCollapsed && sel.rangeCount > 0 && !!sel.anchorNode && screenEl.contains(sel.anchorNode);
    const wasSelecting = selecting;
    selecting = active;
    if (wasSelecting && !selecting && !historyMode) view.render(model.rows);
  });

  // Typing is via the visible compose bar (tapping it opens the keyboard); the
  // screen itself is for reading/scrolling/selecting, so a screen tap no longer
  // summons the keyboard. Send transmits the composed text + Enter.
  el("compose-send").addEventListener("click", () => input.submit());
  el("pastebtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) input.pasteText(text);
    } catch {
      toast("Clipboard blocked");
    }
    input.focus();
  });

  // Special keys (footer + "more keys" sheet). pointerdown — not click — so the
  // press never steals focus from the compose field (the keyboard stays as-is),
  // and arrows can press-and-hold to repeat.
  let repeatDelay: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  function stopRepeat(): void {
    if (repeatDelay) clearTimeout(repeatDelay);
    if (repeatTimer) clearInterval(repeatTimer);
    repeatDelay = repeatTimer = null;
  }
  function wireKeys(container: HTMLElement): void {
    container.addEventListener("pointerdown", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-key]");
      if (!(btn instanceof HTMLElement) || !btn.dataset.key) return;
      e.preventDefault(); // keep focus on the compose field; don't summon/dismiss the keyboard
      const key = btn.dataset.key;
      input.sendKey(key);
      if (btn.dataset.repeat !== undefined) {
        stopRepeat();
        repeatDelay = setTimeout(() => {
          repeatTimer = setInterval(() => input.sendKey(key), 90);
        }, 400);
      }
    });
  }
  wireKeys(el("keys"));
  wireKeys(el("morekeys-grid"));
  wireKeys(autokeysEl);
  document.addEventListener("pointerup", stopRepeat);
  document.addEventListener("pointercancel", stopRepeat);

  // Bottom sheets are mutually exclusive (both are fixed bottom, same z-index).
  el("morebtn").addEventListener("click", () => {
    el("settings").hidden = true;
    el("histpop").hidden = true;
    el("morekeys").hidden = false;
  });
  el("morekeys-close").addEventListener("click", () => (el("morekeys").hidden = true));

  // Settings sheet — Return=Send toggle (default off; preserves today's behavior).
  const setReturnSendsBtn = el("set-returnsends");
  function applyReturnSends(on: boolean): void {
    input.setReturnSends(on);
    setReturnSendsBtn.setAttribute("aria-checked", on ? "true" : "false");
    setReturnSendsBtn.textContent = on ? "On" : "Off";
    composeInput.placeholder = on
      ? "Message — Return or Send to run"
      : "Message — Send to run (Return = newline)";
  }
  applyReturnSends(localStorage.getItem(RETURN_SENDS_KEY) === "on");
  setReturnSendsBtn.addEventListener("click", () => {
    const on = localStorage.getItem(RETURN_SENDS_KEY) !== "on";
    localStorage.setItem(RETURN_SENDS_KEY, on ? "on" : "off");
    applyReturnSends(on);
  });
  el("settings-btn").addEventListener("click", () => {
    el("morekeys").hidden = true;
    el("histpop").hidden = true;
    el("settings").hidden = false;
  });
  el("settings-close").addEventListener("click", () => (el("settings").hidden = true));

  // Soft-wrap toggle + clipped-line hint (right-edge fade when content runs off-screen).
  const setWrapBtn = el("set-wrap");
  function updateClipHint(): void {
    const wrapOn = screenEl.classList.contains("wrap");
    cliphint.hidden = wrapOn || screenEl.scrollLeft + screenEl.clientWidth >= screenEl.scrollWidth - 1;
  }
  function applyWrap(on: boolean): void {
    screenEl.classList.toggle("wrap", on);
    setWrapBtn.setAttribute("aria-checked", on ? "true" : "false");
    setWrapBtn.textContent = on ? "On" : "Off";
    updateClipHint();
  }
  applyWrap(localStorage.getItem(WRAP_KEY) === "on");
  setWrapBtn.addEventListener("click", () => {
    const on = localStorage.getItem(WRAP_KEY) !== "on";
    localStorage.setItem(WRAP_KEY, on ? "on" : "off");
    applyWrap(on);
  });

  // Compose history recall — populate (never auto-send) a prior command.
  const histBtn = el("histbtn");
  const histPop = el("histpop");
  function refreshHistBtn(): void {
    histBtn.hidden = input.history().length === 0;
  }
  function closeHist(): void {
    histPop.hidden = true;
  }
  function openHist(): void {
    const items = input.history();
    histPop.replaceChildren();
    for (const cmd of items) {
      const b = document.createElement("button");
      b.textContent = cmd.replace(/\n/g, " ⏎ ");
      b.title = cmd;
      b.addEventListener("click", () => {
        input.recall(cmd);
        closeHist();
      });
      histPop.appendChild(b);
    }
    histPop.hidden = items.length === 0;
  }
  histBtn.addEventListener("click", () => (histPop.hidden ? openHist() : closeHist()));
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!histPop.hidden && !histPop.contains(t) && t !== histBtn) closeHist();
  });
  refreshHistBtn();

  // Auto-shortcut indicator: tapping it while idle explains what it does.
  if (!autokeysOn) shortcutInd.style.display = "none";
  shortcutInd.addEventListener("click", () => {
    if (!shortcutInd.classList.contains("active")) {
      toast("Shortcut keys appear here automatically when the terminal shows hints (e.g. shift+tab, ctrl+o)");
    }
  });

  // Reconnect when the app returns to foreground or the network comes back —
  // the dominant phone failure (locked/backgrounded PWA loses its WS). Resilience
  // owns this listener; the battery pause/resume hooks in here later.
  const onForeground = (): void => {
    transport.reconnectNow();
    if (model.surfaceId) {
      model.armFull(); // resume re-emits a full frame; ignore stale diffs until then
      transport.send({ t: "resume", surfaceId: model.surfaceId });
    }
  };
  const onBackground = (): void => {
    if (model.surfaceId) transport.send({ t: "pause", surfaceId: model.surfaceId });
  };
  document.addEventListener("visibilitychange", () =>
    document.visibilityState === "visible" ? onForeground() : onBackground(),
  );
  window.addEventListener("online", () => transport.reconnectNow());

  // Self-healing watchdog: if the active surface stays starved of a full frame
  // while the socket is open (the "dim/frozen until I switch panes" bug), force
  // recovery automatically instead of waiting for the user to switch surfaces.
  // Escalates: resync a couple of times, then rebuild the mirror outright.
  const RECOVER_AFTER_MS = 4000;
  let recoveryAttempts = 0;
  setInterval(() => {
    if (!connOpen || !model.surfaceId) return;
    if (!model.isAwaitingFull) {
      recoveryAttempts = 0;
      return;
    }
    if (performance.now() - model.awaitingFullSince < RECOVER_AFTER_MS) return;
    const id = model.surfaceId;
    recoveryAttempts++;
    if (recoveryAttempts <= 2) {
      model.armFull(); // re-arm (resets the clock) and ask the bridge for a fresh full
      transport.send({ t: "resync", surfaceId: id });
    } else {
      // Resyncs didn't take — rebuild the mirror from scratch.
      transport.send({ t: "unsubscribe", surfaceId: id });
      model.armFull();
      transport.send({ t: "subscribe", surfaceId: id });
      recoveryAttempts = 0;
    }
  }, 2000);

  transport.connect();

  if ("serviceWorker" in navigator) {
    // Auto-pick-up new builds: the SW skips waiting + claims on activate, so a
    // fresh deploy fires controllerchange — reload once to load it, no need to
    // remove + re-add the Home Screen icon. (Skip the first-install claim.)
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.update())
      .catch(() => {
        /* PWA install is a nicety; ignore registration failures */
      });
  }
}

main();
