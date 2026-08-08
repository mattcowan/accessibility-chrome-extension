// Message router + lifecycle events. All debugger/CDP logic lives in
// debugger-manager.js; checkers are run by the popup via chrome.scripting.

import * as dbg from './debugger-manager.js';

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg) {
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

    case 'resetTab': {
      const res = await dbg.updateTabState(tabId, (s) => Object.assign(s, dbg.defaultTabState()));
      broadcast(tabId, res.state);
      return res;
    }

    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

// The 1.4.13 checker needs real hover + Escape input. The popup orchestrates:
// start (attach if needed) -> move/escape per candidate -> end (detach if no
// emulation is otherwise active, so the infobar doesn't linger).
async function handleHoverProbe(msg) {
  const { tabId, action } = msg;
  switch (action) {
    case 'start': {
      const res = await dbg.ensureAttached(tabId);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    case 'move':
      await dbg.dispatchMouseMove(tabId, msg.x, msg.y);
      return { ok: true };
    case 'escape':
      await dbg.dispatchEscape(tabId);
      return { ok: true };
    case 'end': {
      const state = await dbg.detachIfIdle(tabId);
      broadcast(tabId, state);
      return { ok: true, state };
    }
    default:
      return { ok: false, error: `Unknown hoverProbe action: ${action}` };
  }
}

// Detached externally: infobar "x" clicked, DevTools attached, target crashed.
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!source.tabId) return;
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
  await dbg.clearTabState(tabId);
  await chrome.storage.session.remove(`findings:${tabId}`);
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
