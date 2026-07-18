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

// Single entry point for all popup-driven state changes.
export async function updateTabState(tabId, mutate) {
  const state = await getTabState(tabId);
  mutate(state);
  if (isAllOff(state)) {
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
