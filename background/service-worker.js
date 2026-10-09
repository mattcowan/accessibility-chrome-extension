// Message router + lifecycle events. All debugger/CDP logic lives in
// debugger-manager.js; checkers are run by the popup, which injects them
// through the `exec` route here (see handleExec).

import * as dbg from './debugger-manager.js';
import { AUDIO_HOOK_SOURCE } from './audio-hook.js';

// The side panel reuses popup.html; the query flag tells popup.js it is
// long-lived (track tab switches/navigations). Manifest default_path can't
// carry a query string reliably, so set it here — this top-level statement
// runs on every SW wake, which is deterministic enough. Guarded hard: a
// missing API or a callback-only setOptions (no Promise returned) must not
// crash the whole service worker at load.
try {
  const p = chrome.sidePanel?.setOptions({ path: 'popup/popup.html?context=panel' });
  if (p && typeof p.catch === 'function') p.catch(() => {});
} catch {
  // sidePanel unavailable on this Chrome build — popup-only operation.
}

function broadcast(tabId, state, reason = null) {
  chrome.runtime.sendMessage({ type: 'stateChanged', tabId, state, reason }).catch(() => {});
}

// Notices that pages post for the popup / side panel; the SW does not answer.
const PAGE_NOTICES = new Set(['errorCaptureUpdate']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || PAGE_NOTICES.has(msg.type)) return false;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg, sender) {
  const { type, tabId } = msg;
  switch (type) {
    case 'getState':
      return {
        ok: true,
        state: await dbg.getTabState(tabId),
        caps: await dbg.getCapabilities(),
      };

    case 'setMediaFeature': {
      if (!dbg.MEDIA_FEATURES.includes(msg.feature)) {
        return { ok: false, error: `Unknown media feature: ${msg.feature}` };
      }
      const res = await dbg.updateTabState(tabId, (s) => {
        s.media[msg.feature] = msg.value || null;
      });
      if (res.ok) broadcast(tabId, res.state);
      return { ...res, caps: await dbg.getCapabilities() };
    }

    case 'setVisionDeficiency': {
      const res = await dbg.updateTabState(tabId, (s) => {
        s.visionDeficiency = msg.value || 'none';
      });
      if (res.ok) broadcast(tabId, res.state);
      return { ...res, caps: await dbg.getCapabilities() };
    }

    case 'setReflow': {
      // value: false/'' (off) | '320' | '320zoom'; legacy true maps to '320'.
      const value =
        msg.value === true ? '320' : ['320', '320zoom'].includes(msg.value) ? msg.value : false;
      const res = await dbg.updateTabState(tabId, (s) => {
        s.reflow = value;
      });
      if (res.ok) broadcast(tabId, res.state);
      return res;
    }

    case 'hoverProbe':
      return handleHoverProbe(msg);

    case 'recordAudio':
      return handleRecordAudio(tabId);

    case 'clickListeners':
      return handleClickListeners(tabId);

    case 'inputWatch':
      return handleInputWatch(msg, sender);

    case 'exec':
      return handleExec(msg, sender);

    case 'resetTab': {
      const res = await dbg.updateTabState(tabId, (s) => Object.assign(s, dbg.defaultTabState()));
      broadcast(tabId, res.state);
      return res;
    }

    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

// Every popup / side-panel injection comes through here (#15). A
// chrome.scripting call made from the popup passes the click's user gesture
// into the page: the page gets user activation and can start audio the
// autoplay policy blocked. The SW is not gesture-free by itself either —
// Chrome forwards the sender's gesture into this onMessage dispatch, so an
// executeScript made in the same task leaks it too. Waiting one task first
// drops it (verified 2026-10-08: after a microtask or a setTimeout(0), the
// page's hasBeenActive stays false). Do not remove the wait.
//   {files, allFrames}                  -> {ok}
//   {global, method, args, allFrames}   -> {ok, results: [{frameId, result}]}
// The call form runs globalThis[global][method](...args) in the isolated
// world; only the namespaces below can be called, and only their own
// function properties (not inherited names such as constructor).
const EXEC_GLOBALS = new Set(['__a11yCheckers', '__a11yHover', '__a11yOps']);

async function handleExec(msg, sender) {
  // Extension pages only (popup, side panel, the E2E popup tab). A content
  // script's sender.url is the page's URL.
  if (!sender || sender.id !== chrome.runtime.id || !(sender.url || '').startsWith(chrome.runtime.getURL(''))) {
    return { ok: false, error: 'exec is for extension pages only' };
  }
  await new Promise((r) => setTimeout(r, 0)); // leave the forwarded gesture behind
  const target = { tabId: msg.tabId, allFrames: msg.allFrames === true };
  if (Array.isArray(msg.files)) {
    await chrome.scripting.executeScript({ target, files: msg.files });
    return { ok: true };
  }
  if (!EXEC_GLOBALS.has(msg.global) || typeof msg.method !== 'string') {
    return { ok: false, error: `exec cannot call ${msg.global}.${msg.method}` };
  }
  // An error thrown inside an injected function does NOT reject
  // executeScript: that frame's result is just null (verified 2026-10-09).
  // A crashed checker would read as "0 findings". So the wrapper catches and
  // returns the error, and a top-frame error fails the call. An error in a
  // subframe only drops that frame's result, as before.
  const results = await chrome.scripting.executeScript({
    target,
    func: async (g, m, a) => {
      try {
        const o = globalThis[g];
        if (!o || !Object.hasOwn(o, m) || typeof o[m] !== 'function') {
          throw new Error(`exec: ${g}.${m} is not a page method (inject its file first)`);
        }
        return { value: await o[m](...a) };
      } catch (e) {
        return { error: (e && e.message) || String(e) };
      }
    },
    args: [msg.global, msg.method, Array.isArray(msg.args) ? msg.args : []],
  });
  const top = results.find((r) => r.frameId === 0);
  if (top && top.result && top.result.error) return { ok: false, error: top.result.error };
  return {
    ok: true,
    results: results.map((r) => ({ frameId: r.frameId, result: r.result && !r.result.error ? r.result.value : null })),
  };
}

// Debugger holds (see debugger-manager.js) for the click-listener read and
// Reload and record. The hover probe uses holdHover/touchHover/releaseHover.
function holdDebugger(tabId) {
  dbg.holdDebugger(tabId);
}

async function releaseDebugger(tabId) {
  const state = await dbg.releaseDebugger(tabId);
  broadcast(tabId, state);
  return state;
}

// The 1.4.13 checker needs real hover + Escape input. The popup orchestrates:
// start (attach if needed) -> move/escape per candidate -> end (detach if no
// emulation or other debugger user is active, so the infobar doesn't linger).
async function handleHoverProbe(msg) {
  const { tabId, action } = msg;
  switch (action) {
    case 'start': {
      const res = await dbg.ensureAttached(tabId);
      if (res.ok) dbg.holdHover(tabId);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    case 'move':
      dbg.touchHover(tabId);
      await dbg.dispatchMouseMove(tabId, msg.x, msg.y);
      return { ok: true };
    case 'escape':
      dbg.touchHover(tabId);
      await dbg.dispatchEscape(tabId);
      return { ok: true };
    case 'end': {
      const state = await dbg.releaseHover(tabId);
      broadcast(tabId, state);
      return { ok: true, state };
    }
    default:
      return { ok: false, error: `Unknown hoverProbe action: ${action}` };
  }
}

// The mouse-only scan (2.1.1) needs the page's click listeners, which only
// CDP can read. Attach, read, then detach again if nothing else needs the
// debugger. Refused during Reload and record: the page is reloading, so the
// listeners read would belong to a page that is going away.
async function handleClickListeners(tabId) {
  if (recordingTabs.has(tabId)) {
    return { ok: false, error: 'Reload and record is running on this tab' };
  }
  holdDebugger(tabId);
  try {
    const attach = await dbg.ensureAttached(tabId);
    if (!attach.ok) return { ok: false, error: attach.error };
    const { paths, truncated } = await dbg.clickListenerPaths(tabId);
    return { ok: true, paths, truncated };
  } finally {
    await releaseDebugger(tabId);
  }
}

// The audio checker's "Reload and record": install the page-world recorder,
// reload, wait for the load, then remove the script (so later navigations are
// not hooked) and detach if no emulation is active. The hook already in the
// page keeps recording. The whole cycle runs here, not in the popup, so a
// popup that closes mid-way cannot leave the script installed.
const RECORD_LOAD_TIMEOUT_MS = 30000;

function waitForReload(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const done = (loaded) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(loaded);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      else if (info.status === 'complete' && sawLoading) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Tabs with a recording in progress. The popup and the side panel can both be
// open on one tab, and a second run would remove the first one's script and
// detach mid-reload. In-memory is safe here, unlike emulation state: the open
// message channel keeps the SW alive for the whole cycle, and if the SW dies
// the cycle dies with it.
const recordingTabs = new Set();

async function handleRecordAudio(tabId) {
  if (recordingTabs.has(tabId)) {
    return { ok: false, error: 'Reload and record is already running on this tab.' };
  }
  recordingTabs.add(tabId);
  try {
    return await recordAudioCycle(tabId);
  } finally {
    recordingTabs.delete(tabId);
  }
}

async function recordAudioCycle(tabId) {
  holdDebugger(tabId);
  let scriptId = null;
  try {
    const attach = await dbg.ensureAttached(tabId);
    if (!attach.ok) return { ok: false, error: attach.error };
    scriptId = await dbg.addScriptOnNewDocument(tabId, AUDIO_HOOK_SOURCE);
    const reloaded = waitForReload(tabId, RECORD_LOAD_TIMEOUT_MS);
    await chrome.tabs.reload(tabId);
    return { ok: true, loaded: await reloaded };
  } finally {
    if (scriptId) await dbg.removeScriptOnNewDocument(tabId, scriptId).catch(() => {});
    await releaseDebugger(tabId);
  }
}

// Input watcher (3.2.2 / 4.1.2, TT 5.D / 5.E). A navigation ends the page
// script, so the watcher's log lives here, in chrome.storage.session under
// `watch:${tabId}` (never in SW memory): {active, startedAt, last, events, seq}.
// seq counts every event ever logged; it keeps growing after the events list
// hits its cap, so a listener can still see that something was added.
// The page marks each field change; a navigation or a new tab within
// WATCH_MARK_MS of the mark is logged against that field. The popup turns the
// log into findings. The watcher never attaches the debugger.
const WATCH_MARK_MS = 5000;
const WATCH_EVENT_CAP = 300;
const WATCH_PAGE_ACTIONS = new Set(['mark', 'unmark', 'event']);
const watchKey = (tabId) => `watch:${tabId}`;

// Page messages and tab events race to read-modify-write the same entry, so
// each tab's updates run in order. The queue only orders writes; it holds no
// state that a restarted SW would need.
const watchQueues = new Map();

function updateWatch(tabId, fn) {
  const prev = watchQueues.get(tabId) || Promise.resolve();
  const next = prev.then(async () => {
    const key = watchKey(tabId);
    const state = (await chrome.storage.session.get(key))[key] || null;
    const out = fn(state);
    if (out === undefined) return state; // no change
    if (out === null) await chrome.storage.session.remove(key);
    else await chrome.storage.session.set({ [key]: out });
    return out;
  });
  const settled = next.catch(() => {});
  watchQueues.set(tabId, settled);
  settled.then(() => {
    if (watchQueues.get(tabId) === settled) watchQueues.delete(tabId);
  });
  return next;
}

function logWatchEvent(state, event) {
  return {
    ...state,
    events: [...state.events, { ...event, at: Date.now() }].slice(-WATCH_EVENT_CAP),
    seq: (state.seq || 0) + 1,
  };
}

async function handleInputWatch(msg, sender) {
  const { action } = msg;
  if (WATCH_PAGE_ACTIONS.has(action)) {
    // From the watcher's content script in the tab's top frame only.
    const fromPage =
      sender && sender.tab && sender.frameId === 0 && !(sender.url || '').startsWith(chrome.runtime.getURL(''));
    if (!fromPage) return { ok: false, error: 'Not from a watched page' };
    const tabId = sender.tab.id;
    await updateWatch(tabId, (s) => {
      if (!s || !s.active) return undefined;
      if (action === 'mark') return { ...s, last: { ...msg.field, cause: msg.cause, at: Date.now() } };
      if (action === 'unmark') return { ...s, last: null };
      return logWatchEvent(s, msg.event);
    });
    return { ok: true };
  }
  const { tabId } = msg;
  switch (action) {
    case 'start': {
      // A session that a navigation interrupted keeps its log.
      const state = await updateWatch(tabId, (s) =>
        s && s.active ? { ...s, last: null } : { active: true, startedAt: Date.now(), last: null, events: [] }
      );
      return { ok: true, state };
    }
    case 'stop': {
      // The page hands over what its open window saw (msg.events); log it,
      // return the final log for the popup, then remove it.
      let final = null;
      await updateWatch(tabId, (s) => {
        final = s && s.active ? (msg.events || []).reduce(logWatchEvent, s) : s;
        return null;
      });
      return { ok: true, state: final };
    }
    case 'status':
      return { ok: true, state: await updateWatch(tabId, () => undefined) };
    default:
      return { ok: false, error: `Unknown inputWatch action: ${action}` };
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, t) => {
  if (changeInfo.status !== 'loading') return;
  updateWatch(tabId, (s) => {
    if (!s || !s.active || !s.last || Date.now() - s.last.at > WATCH_MARK_MS) return undefined;
    const event = { kind: 'navigation', cause: s.last.cause, field: s.last, to: changeInfo.url || (t && t.url) || '' };
    return { ...logWatchEvent(s, event), last: null };
  }).catch(() => {});
});

chrome.tabs.onCreated.addListener((t) => {
  if (t.openerTabId == null) return;
  updateWatch(t.openerTabId, (s) => {
    if (!s || !s.active || !s.last || Date.now() - s.last.at > WATCH_MARK_MS) return undefined;
    return logWatchEvent(s, { kind: 'new-tab', cause: s.last.cause, field: s.last, to: t.pendingUrl || t.url || '' });
  }).catch(() => {});
});

// Detached externally: infobar "x" clicked, DevTools attached, target crashed.
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!source.tabId) return;
  dbg.clearHolds(source.tabId);
  await dbg.clearTabState(source.tabId);
  broadcast(
    source.tabId,
    dbg.defaultTabState(),
    reason === 'canceled_by_user'
      ? 'Emulation stopped: the debugging bar was dismissed or DevTools took over the tab.'
      : `Emulation stopped (${reason}).`
  );
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  dbg.clearHolds(tabId);
  await dbg.clearTabState(tabId);
  await chrome.storage.session.remove([`findings:${tabId}`, watchKey(tabId)]);
});

// Re-apply emulation on navigation. Overrides should persist within a session,
// but cross-process navigations have been flaky historically; re-applying is
// cheap and idempotent. A failure during 'loading' is retried at 'complete'.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  const state = await dbg.getTabState(tabId);
  if (!state.attached) return;
  try {
    await dbg.applyState(tabId, state);
  } catch {
    // 'loading'-phase races ("target closed") are retried by the 'complete'
    // event; a 'complete'-phase failure means the session is gone and
    // onDetach will clean up.
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[a11y-modes] installed');
});
