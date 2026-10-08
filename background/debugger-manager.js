// Owns the chrome.debugger lifecycle and CDP emulation state per tab.
//
// All state is mirrored to chrome.storage.session: the MV3 service worker can
// be terminated after ~30s idle while the debugger attachment survives
// browser-side, so in-memory state can never be trusted across events.

const PROTOCOL_VERSION = '1.3';
const CAPS_KEY = 'caps';

export const MEDIA_FEATURES = [
  'prefers-reduced-motion',
  'prefers-color-scheme',
  'forced-colors',
  'prefers-contrast',
  'prefers-reduced-transparency',
  'inverted-colors',
];

export function defaultTabState() {
  const media = {};
  for (const f of MEDIA_FEATURES) media[f] = null;
  return { attached: false, media, visionDeficiency: 'none', reflow: false, lastError: null };
}

const stateKey = (tabId) => `tab:${tabId}`;

export async function getTabState(tabId) {
  const key = stateKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? defaultTabState();
}

async function saveTabState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
}

export async function clearTabState(tabId) {
  await chrome.storage.session.remove(stateKey(tabId));
}

function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // "not attached" — nothing to do
  }
}

export function friendlyAttachError(message) {
  if (/another debugger|already attached/i.test(message)) {
    return 'Another debugger (usually DevTools) is attached to this tab. Close DevTools on this tab and try again.';
  }
  if (/cannot attach|cannot access|not allowed|restricted/i.test(message)) {
    return "Emulation isn't available on this page (browser, store, or extension pages).";
  }
  return message;
}

export async function getCapabilities() {
  const stored = await chrome.storage.session.get(CAPS_KEY);
  return stored[CAPS_KEY] ?? null;
}

// Some CDP values are newer than the minimum supported Chrome: probe once per
// browser session and let the popup hide what this Chrome rejects.
async function probeCapabilities(tabId) {
  if (await getCapabilities()) return;
  const caps = {
    'prefers-reduced-transparency': true,
    'inverted-colors': true,
    reducedContrast: true,
  };
  const probes = [
    ['prefers-reduced-transparency', { name: 'prefers-reduced-transparency', value: 'reduce' }],
    ['inverted-colors', { name: 'inverted-colors', value: 'inverted' }],
  ];
  for (const [cap, feature] of probes) {
    try {
      await sendCommand(tabId, 'Emulation.setEmulatedMedia', { features: [feature] });
    } catch {
      caps[cap] = false;
    }
  }
  try {
    await sendCommand(tabId, 'Emulation.setEmulatedVisionDeficiency', { type: 'reducedContrast' });
  } catch {
    caps.reducedContrast = false;
  }
  // Undo whatever the probe set; applyState() writes the real values next.
  await sendCommand(tabId, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  await sendCommand(tabId, 'Emulation.setEmulatedVisionDeficiency', { type: 'none' }).catch(() => {});
  await chrome.storage.session.set({ [CAPS_KEY]: caps });
}

export async function ensureAttached(tabId) {
  const state = await getTabState(tabId);
  if (state.attached) {
    const targets = await chrome.debugger.getTargets();
    if (targets.some((t) => t.tabId === tabId && t.attached)) return { ok: true, state };
    state.attached = false;
  }
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    state.lastError = friendlyAttachError(e.message);
    return { ok: false, error: state.lastError, state };
  }
  state.attached = true;
  state.lastError = null;
  await saveTabState(tabId, state);
  await probeCapabilities(tabId);
  return { ok: true, state };
}

// Re-sends every override from stored state. Idempotent; used after attach and
// re-applied on navigation (CDP persistence across cross-process navigations
// under chrome.debugger is not trusted).
export async function applyState(tabId, state) {
  const features = [];
  for (const [name, value] of Object.entries(state.media)) {
    if (value) features.push({ name, value });
  }
  await sendCommand(tabId, 'Emulation.setEmulatedMedia', { media: '', features });
  await sendCommand(tabId, 'Emulation.setEmulatedVisionDeficiency', {
    type: state.visionDeficiency || 'none',
  });
  if (state.reflow) {
    // '320' = bare 320 CSS px viewport; '320zoom' = the same layout viewport
    // rendered at 4x — visually equivalent to a 1280px window at 400% browser
    // zoom, the canonical WCAG 1.4.10 test condition.
    await sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
      scale: state.reflow === '320zoom' ? 4 : 1,
    });
  } else {
    await sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
}

export function isAllOff(state) {
  return (
    Object.values(state.media).every((v) => !v) &&
    (!state.visionDeficiency || state.visionDeficiency === 'none') &&
    !state.reflow
  );
}

// Detach (removing the infobar) when nothing is being emulated anymore.
// Detaching clears all CDP overrides browser-side.
export async function detachIfIdle(tabId) {
  const state = await getTabState(tabId);
  if (!state.attached || !isAllOff(state)) return state;
  await detachDebugger(tabId);
  await clearTabState(tabId);
  return defaultTabState();
}

// Transient debugger users on a tab (hover probe start→end, the click-listener
// read, Reload and record). Each holds the session while it works; the
// debugger detaches only when no hold is left AND no emulation is on, so
// neither one user's cleanup nor an emulation toggle can detach another user
// mid-way (the popup and the side panel can both drive one tab).
// In memory, unlike tab state: if the SW dies, the holds die with it, and the
// worst case is the old behavior (an early detach).
//
// Two kinds. The listener read and Reload and record run inside one SW call
// with a finally, so their `calls` count always comes back down. The hover
// probe spans many popup messages, and a popup that closes before 'end'
// would orphan its hold and keep the infobar up for good; so a hover hold
// lapses when no hover message arrived for HOVER_HOLD_STALE_MS. A running
// probe sends one about every second.
const HOVER_HOLD_STALE_MS = 15000;
const debuggerHolds = new Map(); // tabId -> {calls, hovers, lastHover}

function holdsFor(tabId) {
  let h = debuggerHolds.get(tabId);
  if (!h) {
    h = { calls: 0, hovers: 0, lastHover: 0 };
    debuggerHolds.set(tabId, h);
  }
  return h;
}

function hasActiveHold(tabId) {
  const h = debuggerHolds.get(tabId);
  if (!h) return false;
  return h.calls > 0 || (h.hovers > 0 && Date.now() - h.lastHover < HOVER_HOLD_STALE_MS);
}

// Detach if this was the last active hold and no emulation is on. Returns the
// tab state after it.
async function afterRelease(tabId) {
  const h = debuggerHolds.get(tabId);
  if (h && h.calls <= 0 && h.hovers <= 0) debuggerHolds.delete(tabId);
  return hasActiveHold(tabId) ? getTabState(tabId) : detachIfIdle(tabId);
}

export function holdDebugger(tabId) {
  holdsFor(tabId).calls++;
}

export async function releaseDebugger(tabId) {
  const h = holdsFor(tabId);
  h.calls = Math.max(0, h.calls - 1);
  return afterRelease(tabId);
}

// Hover probe: 'start' takes the hold, 'move'/'escape' keep it fresh, 'end'
// releases it.
export function holdHover(tabId) {
  const h = holdsFor(tabId);
  h.hovers++;
  h.lastHover = Date.now();
}

export function touchHover(tabId) {
  const h = debuggerHolds.get(tabId);
  if (h && h.hovers > 0) h.lastHover = Date.now();
}

export async function releaseHover(tabId) {
  const h = holdsFor(tabId);
  h.hovers = Math.max(0, h.hovers - 1);
  return afterRelease(tabId);
}

// Nothing is attached any more (external detach, tab closed), so no hold can
// be honored.
export function clearHolds(tabId) {
  debuggerHolds.delete(tabId);
}

// Single entry point for all popup-driven state changes.
export async function updateTabState(tabId, mutate) {
  const state = await getTabState(tabId);
  mutate(state);
  if (isAllOff(state)) {
    if (state.attached && hasActiveHold(tabId)) {
      // A hold-taker is mid-way: clear the overrides but stay attached. The
      // last releaseDebugger detaches (detachIfIdle sees all-off).
      await applyState(tabId, state).catch(() => {});
      await saveTabState(tabId, state);
      return { ok: true, state };
    }
    if (state.attached) await detachDebugger(tabId);
    await clearTabState(tabId);
    return { ok: true, state: defaultTabState() };
  }
  const attach = await ensureAttached(tabId);
  if (!attach.ok) {
    return { ok: false, error: attach.error, state: await getTabState(tabId) };
  }
  state.attached = true;
  state.lastError = null;
  try {
    await applyState(tabId, state);
  } catch (e) {
    state.lastError = e.message;
    await saveTabState(tabId, state);
    return { ok: false, error: e.message, state };
  }
  await saveTabState(tabId, state);
  return { ok: true, state };
}

// --- Page-world script injection for the audio checker's Reload and record --
// Runs `source` in the main world of every new document (and its same-process
// frames) before page scripts. Returns the identifier to remove it with.

export async function addScriptOnNewDocument(tabId, source) {
  await sendCommand(tabId, 'Page.enable');
  const { identifier } = await sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
  return identifier;
}

export async function removeScriptOnNewDocument(tabId, identifier) {
  await sendCommand(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier });
}

// --- Click listeners for the mouse-only scan (2.1.1 / TT 4.A) ---------------
// Content scripts cannot see addEventListener listeners; CDP can. Returns
// {path, tag} for every element that has a click-type listener: the
// child-index path from the top document (-1 = enter the shadow root), for
// the checker in the page to resolve, and the tag name it checks against.
// Known gaps: nodes inside iframes return no path, and a path through a
// CLOSED shadow root does not resolve in the page (shadowRoot is null).

const CLICK_TYPES = new Set(['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']);
const LISTENER_NODE_CAP = 500;
const LISTENER_GROUP = 'a11y-click-listeners';
// CDP errors for a node or object that no longer exists. "Cannot find
// context" is deliberately not here: it means the page navigated, and paths
// read before that point would be resolved against the new page.
const NODE_GONE = /No node with given id|Could not find (node|object) with given id/i;

// Runs in the page's main world with `this` = the element. No page code is
// called, and no gesture is passed (Runtime.callFunctionOn defaults to none).
const PATH_FN = `function () {
  if (window !== window.top) return null;
  const path = [];
  let node = this;
  while (node && node !== document) {
    const parent = node.parentNode;
    if (!parent || !parent.children) return null;
    let i = 0;
    while (i < parent.children.length && parent.children[i] !== node) i++;
    if (i === parent.children.length) return null;
    path.unshift(i);
    if (parent.nodeType === 11) {
      path.unshift(-1);
      node = parent.host;
    } else {
      node = parent;
    }
  }
  return node === document ? { path: path, tag: this.tagName } : null;
}`;

export async function clickListenerPaths(tabId) {
  try {
    const { result: doc } = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'document',
      objectGroup: LISTENER_GROUP,
    });
    const { listeners } = await sendCommand(tabId, 'DOMDebugger.getEventListeners', {
      objectId: doc.objectId,
      depth: -1,
      pierce: true,
    });
    const ids = [
      ...new Set(
        listeners.filter((l) => CLICK_TYPES.has(l.type) && l.backendNodeId).map((l) => l.backendNodeId)
      ),
    ];
    const paths = [];
    for (const backendNodeId of ids.slice(0, LISTENER_NODE_CAP)) {
      try {
        const { object } = await sendCommand(tabId, 'DOM.resolveNode', {
          backendNodeId,
          objectGroup: LISTENER_GROUP,
        });
        const { result } = await sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: PATH_FN,
          returnByValue: true,
        });
        if (result.value && Array.isArray(result.value.path)) paths.push(result.value);
      } catch (e) {
        // Only a node that went away between the calls is skipped. Anything
        // else (the session detached, the tab closed) fails the whole read,
        // so a partial list is never reported as complete.
        if (!NODE_GONE.test(e && e.message)) throw e;
      }
    }
    return { paths, truncated: ids.length > LISTENER_NODE_CAP };
  } finally {
    await sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup: LISTENER_GROUP }).catch(() => {});
  }
}

// --- Input dispatch for the hover/focus-content (1.4.13) probe -------------
// Real CDP mouse moves trigger CSS :hover, which JS-synthesized events cannot.

export async function dispatchMouseMove(tabId, x, y) {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: 0,
    pointerType: 'mouse',
  });
}

export async function dispatchEscape(tabId) {
  const base = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
