// Popup: emulation controls (via the service worker / CDP), checker runner
// (injection under activeTab, made by the SW's `exec` route — never from this
// page, see inject()), findings store with run-over-run diff, and CSV export.
// The same page also serves as the Chrome side panel (?context=panel), where
// it additionally tracks the active tab.

import { downloadCsv, downloadTable } from './csv.js';

const LIBS = ['checkers/lib/selector.js', 'checkers/lib/findings.js'];
const OVERLAY = 'checkers/lib/overlay.js';
// The popup's own page-side helpers (reveal, highlight, markers).
const OPS = 'checkers/lib/ops.js';
const REVEAL_FILES = ['checkers/lib/resolve.js', OVERLAY, OPS];
// Mechanism finder for auto-playing and auto-updating content (TT 2.A, 2.B,
// 2.C); needs accname.
const MECHANISM = ['checkers/lib/accname.js', 'checkers/lib/mechanism.js'];
// Focus-indicator style diff shared by the Focus visibility walker and the
// focus locator.
const FOCUS_STYLE = 'checkers/lib/focus-style.js';
const LOCATOR_FILES = [...LIBS, 'checkers/lib/accname.js', FOCUS_STYLE, 'checkers/focus-locator.js'];
// After Reload and record, wait this long for page scripts to start audio
// (and for Chrome's tab "audible" flag, which lags a moment) before checking.
const RECORD_SETTLE_MS = 4000;
let recordingAudio = false; // Reload and record in progress (side panel guards)
let autoUpdateRunning = false; // an Auto-update watch is counting down (side panel guard)
let tabSwitchedWhileRecording = false; // side panel: re-sync once recording ends
// Live-region detection, shared by the monitor, Error capture and the Input
// watcher.
const LIVE = 'checkers/lib/live.js';
const LIVE_FILES = [...LIBS, LIVE, 'checkers/live-regions.js'];
// Table model (HTML header algorithm), shared by Tables and the form tools.
const TABLE_LIB = 'checkers/lib/table.js';
const TABLE_FILES = ['checkers/lib/resolve.js', TABLE_LIB, 'checkers/tables.js'];
const CSS_POSITION_FILES = ['checkers/css-position.js'];
// Form-field helpers (group labels, table headers, nearby text) for the three
// Trusted Tester section 5 tools.
const FORMS = ['checkers/lib/accname.js', TABLE_LIB, 'checkers/lib/forms.js'];
const ERROR_FILES = [...LIBS, ...FORMS, FOCUS_STYLE, LIVE, 'checkers/error-capture.js'];
const WATCH_FILES = [...LIBS, ...FORMS, LIVE, 'checkers/input-watcher.js'];
const LIVE_LOG_COLUMNS = ['selector', 'politeness', 'role', 'message', 'timestamp', 'url'];
// Auto-update (TT 2.C / 2.D) watch time, in whole seconds. Kept in
// chrome.storage.local under 'autoUpdateSeconds'.
const AUTO_UPDATE_DEFAULT_S = 10;
const AUTO_UPDATE_MAX_S = 300;

const $ = (id) => document.getElementById(id);
const fingerprint = (f) => `${f.tool}|${f.wcag}|${f.selector}`;

// Same page serves as action popup and as the Chrome side panel; the SW
// registers the panel path with ?context=panel so we know which we are.
const IS_PANEL = new URLSearchParams(location.search).get('context') === 'panel';

let tab = null;
let restricted = false;
let lastState = null; // latest emulation state from the SW (renderState keeps it fresh)

// ---------------------------------------------------------------- utilities

function normUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

function isRestricted(url) {
  if (!url) return true;
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    return host === 'chromewebstore.google.com' || host === 'chrome.google.com';
  } catch {
    return true;
  }
}

function banner(text) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = !text;
}

function announce(text) {
  $('status').textContent = text;
}

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId: tab.id });
}

// Every injection goes through the SW (#15). A chrome.scripting call from
// this page carries the click's user gesture into the page, which gives the
// page user activation (it can then start audio the autoplay policy blocked,
// open pop-ups, and so on). The SW's `exec` route injects without it. Do not
// call chrome.scripting from this file.
async function exec(msg) {
  const res = await send({ type: 'exec', ...msg });
  if (!res || !res.ok) throw new Error((res && res.error) || 'The service worker did not run the script.');
  return res.results;
}

async function inject(files, allFrames = false) {
  await exec({ files, allFrames });
}

// globalThis[global][method](...args) in the page -> [{frameId, result}].
function pageCall(global, method, args = [], allFrames = false) {
  return exec({ global, method, args, allFrames });
}

function callChecker(name, arg = null, allFrames = false) {
  return pageCall('__a11yCheckers', name, [arg], allFrames);
}

async function hoverCall(method, index) {
  const [res] = await pageCall('__a11yHover', method, [index]);
  return res.result;
}

// The stateful tools' page markers (which ones are running).
async function pageMarkers() {
  await inject([OPS]);
  const [res] = await pageCall('__a11yOps', 'markers');
  return res.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkerError(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/cannot access|activeTab|permission/i.test(msg)) {
    banner(
      IS_PANEL
        ? 'Cannot access this page from the side panel. Click the extension toolbar icon on this tab to re-grant access, then re-run. (Emulation toggles keep working regardless.)'
        : 'Cannot access this page. If you navigated after opening the popup, close and reopen it to re-grant access.'
    );
  } else {
    banner(`Checker failed: ${msg}`);
  }
}

// ------------------------------------------------------- emulation controls

function renderState(state, caps) {
  lastState = state;
  $('toggle-reduced-motion').checked = state.media['prefers-reduced-motion'] === 'reduce';
  const scheme = state.media['prefers-color-scheme'] || '';
  document.querySelector(`input[name="color-scheme"][value="${scheme}"]`).checked = true;
  $('toggle-forced-colors').checked = state.media['forced-colors'] === 'active';
  const contrast = state.media['prefers-contrast'] || '';
  document.querySelector(`input[name="contrast"][value="${contrast}"]`).checked = true;
  $('toggle-reduced-transparency').checked =
    state.media['prefers-reduced-transparency'] === 'reduce';
  $('toggle-inverted-colors').checked = state.media['inverted-colors'] === 'inverted';
  const reflow = state.reflow === true ? '320' : state.reflow || '';
  const reflowInput = document.querySelector(`input[name="reflow"][value="${reflow}"]`);
  if (reflowInput) reflowInput.checked = true;
  $('run-reflow-scan').disabled = !state.reflow;
  const reflowBatchBox = document.querySelector('.batch-select[data-batch-id="reflow"]');
  if (reflowBatchBox) reflowBatchBox.disabled = !state.reflow;
  $('toggle-reduced-motion-inline').checked = state.media['prefers-reduced-motion'] === 'reduce';
  const vision = state.visionDeficiency || 'none';
  const visionInput = document.querySelector(`input[name="vision"][value="${vision}"]`);
  if (visionInput) visionInput.checked = true;

  if (caps) {
    $('row-reduced-transparency').hidden = !caps['prefers-reduced-transparency'];
    $('row-inverted-colors').hidden = !caps['inverted-colors'];
    $('vision-reducedContrast').closest('label').hidden = !caps.reducedContrast;
  }
}

async function applySetting(msg, revert) {
  banner('');
  const res = await send(msg);
  if (!res || !res.ok) {
    banner(res && res.error ? res.error : 'Something went wrong applying the setting.');
    revert();
    if (res && res.state) renderState(res.state, res.caps);
    return;
  }
  renderState(res.state, res.caps);
}

function wireEmulation() {
  $('toggle-reduced-motion').addEventListener('change', (e) =>
    applySetting(
      { type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: e.target.checked ? 'reduce' : null },
      () => (e.target.checked = !e.target.checked)
    )
  );
  // Inline twin of the toggle above, living in the Motion checker row.
  // renderState keeps both in sync from the same SW state.
  $('toggle-reduced-motion-inline').addEventListener('change', (e) =>
    applySetting(
      { type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: e.target.checked ? 'reduce' : null },
      () => (e.target.checked = !e.target.checked)
    )
  );
  for (const input of document.querySelectorAll('input[name="color-scheme"]')) {
    input.addEventListener('change', () =>
      applySetting(
        { type: 'setMediaFeature', feature: 'prefers-color-scheme', value: input.value || null },
        () => {}
      )
    );
  }
  $('toggle-forced-colors').addEventListener('change', (e) =>
    applySetting(
      { type: 'setMediaFeature', feature: 'forced-colors', value: e.target.checked ? 'active' : null },
      () => (e.target.checked = !e.target.checked)
    )
  );
  for (const input of document.querySelectorAll('input[name="contrast"]')) {
    input.addEventListener('change', () =>
      applySetting(
        { type: 'setMediaFeature', feature: 'prefers-contrast', value: input.value || null },
        () => {}
      )
    );
  }
  $('toggle-reduced-transparency').addEventListener('change', (e) =>
    applySetting(
      { type: 'setMediaFeature', feature: 'prefers-reduced-transparency', value: e.target.checked ? 'reduce' : null },
      () => (e.target.checked = !e.target.checked)
    )
  );
  $('toggle-inverted-colors').addEventListener('change', (e) =>
    applySetting(
      { type: 'setMediaFeature', feature: 'inverted-colors', value: e.target.checked ? 'inverted' : null },
      () => (e.target.checked = !e.target.checked)
    )
  );
  for (const input of document.querySelectorAll('input[name="reflow"]')) {
    input.addEventListener('change', () =>
      applySetting({ type: 'setReflow', value: input.value || false }, () => {})
    );
  }
  for (const input of document.querySelectorAll('input[name="vision"]')) {
    input.addEventListener('change', () =>
      applySetting({ type: 'setVisionDeficiency', value: input.value }, () => {})
    );
  }
}

// ------------------------------------------------------------ findings store

const findingsKey = () => `findings:${tab.id}`;

async function getStore() {
  const key = findingsKey();
  const stored = await chrome.storage.session.get(key);
  const store = stored[key] ?? { url: tab.url, tools: {} };
  // One report per page: if this tab has navigated to a different URL since
  // findings were stored, start fresh rather than stacking sites in one report.
  if (normUrl(store.url) !== normUrl(tab.url)) {
    return { url: tab.url, tools: {} };
  }
  return store;
}

// final: false for an incremental update of a running tool (Error capture,
// Input watcher). Status and "resolved" are still computed against the last
// finished run, but the history is not overwritten, so a finding found seconds
// earlier in the same session stays "new". The tool's Stop writes it (final).
async function storeToolFindings(tool, rawFindings, { final = true } = {}) {
  const url = tab.url;
  const now = new Date().toISOString();
  // A finding may carry its own url: the Input watcher logs a field on the
  // page the tab has since navigated away from.
  const stamped = rawFindings.map((f) => ({ ...f, url: f.url || url, timestamp: now }));

  // Diff against the previous run for this URL+tool (survives restarts).
  const histKey = `history:${normUrl(url)}:${tool}`;
  const prev = (await chrome.storage.local.get(histKey))[histKey];
  const prevMap = new Map((prev?.findings || []).map((f) => [fingerprint(f), f]));
  const currentSet = new Set(stamped.map(fingerprint));
  for (const f of stamped) f.status = prevMap.has(fingerprint(f)) ? 'existing' : 'new';
  const resolved = [...prevMap.values()]
    .filter((f) => !currentSet.has(fingerprint(f)))
    .map((f) => ({ ...f, status: 'resolved', timestamp: now }));
  if (final) await chrome.storage.local.set({ [histKey]: { findings: stamped } });

  const store = await getStore();
  store.url = url;
  store.tools[tool] = { findings: stamped, resolved };
  await chrome.storage.session.set({ [findingsKey()]: store });
  renderReport(store);
  return { findings: stamped, resolved };
}

const BADGE_BY_TOOL = {
  motion: 'badge-motion',
  audio: 'badge-audio',
  'auto-update': 'badge-auto-update',
  'text-spacing': 'badge-text-spacing',
  'focus-visibility': 'badge-focus',
  'keyboard-access': 'badge-keyboard-access',
  'form-labels': 'badge-form-labels',
  tables: 'badge-tables',
  'css-position': 'badge-css-position',
  'error-capture': 'badge-error-capture',
  'input-watcher': 'badge-input-watcher',
  'target-size': 'badge-target-size',
  'hover-content': 'badge-hover',
  reflow: 'badge-reflow',
  accname: 'badge-accname',
  'live-regions': 'badge-live-regions',
};

function renderBadge(tool, findings) {
  const el = $(BADGE_BY_TOOL[tool]);
  if (!el) return;
  const fails = findings.filter((f) => f.severity === 'fail').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  el.hidden = false;
  if (fails) {
    el.className = 'badge fail';
    el.textContent = String(fails);
    el.title = `${fails} fail`;
  } else if (warns) {
    el.className = 'badge warn';
    el.textContent = String(warns);
    el.title = `${warns} warn`;
  } else if (findings.length) {
    el.className = 'badge review';
    el.textContent = String(findings.length);
    el.title = `${findings.length} review`;
  } else {
    el.className = 'badge clean';
    el.textContent = '0';
    el.title = 'no findings';
  }
}

async function clearFindingsStore() {
  await chrome.storage.session.remove([findingsKey(), tablesKey()]);
  for (const id of Object.values(BADGE_BY_TOOL)) $(id).hidden = true;
  renderReport({ url: tab.url, tools: {} });
  renderTables(null);
}

function allFindings(store) {
  const current = [];
  const resolved = [];
  for (const data of Object.values(store.tools)) {
    current.push(...data.findings);
    resolved.push(...(data.resolved || []));
  }
  return { current, resolved };
}

let lastStore = null;
const expandedTools = new Set(); // tools whose group shows all rows (past the cap)
const GROUP_ROW_CAP = 30;

const isRevealable = (sel) => sel && sel !== '(page)' && sel !== '(unknown)';

function findingRow(f) {
  const li = document.createElement('li');
  li.className = 'finding';
  const clickable = isRevealable(f.selector);
  const container = document.createElement(clickable ? 'button' : 'div');
  if (clickable) {
    container.type = 'button';
    container.className = 'finding-reveal';
    container.dataset.selector = f.selector;
    container.dataset.severity = f.severity;
    container.title = 'Scroll to and highlight this element on the page';
  } else {
    container.className = 'finding-static';
  }

  const head = document.createElement('div');
  head.className = 'finding-head';
  const sev = document.createElement('span');
  sev.className = `sev sev-${f.severity}`;
  sev.textContent = f.severity;
  const wcag = document.createElement('span');
  wcag.className = 'wcag';
  wcag.textContent = f.wcag;
  const sel = document.createElement('code');
  sel.className = 'sel';
  sel.textContent = f.selector;
  head.append(sev, wcag, sel);
  if (f.status === 'new') {
    const chip = document.createElement('span');
    chip.className = 'chip-new';
    chip.textContent = 'new';
    head.appendChild(chip);
  }

  const det = document.createElement('div');
  det.className = 'finding-details';
  det.textContent = f.details || '';

  container.append(head, det);
  li.appendChild(container);
  return li;
}

function renderReport(store) {
  lastStore = store;
  for (const [tool, data] of Object.entries(store.tools)) {
    renderBadge(tool, data.findings);
  }
  const { current, resolved } = allFindings(store);
  if (!current.length && !resolved.length) {
    $('report-summary').textContent = 'No findings yet.';
    $('findings-groups').replaceChildren();
    return;
  }
  const count = (sev) => current.filter((f) => f.severity === sev).length;
  const fresh = current.filter((f) => f.status === 'new').length;
  $('report-summary').textContent =
    `${current.length} findings — ${count('fail')} fail, ${count('warn')} warn, ` +
    `${count('review')} review. Vs last run: ${fresh} new, ${current.length - fresh} existing, ` +
    `${resolved.length} resolved.`;

  const groups = $('findings-groups');
  // Keep groups the user opened open across re-renders.
  const openTools = new Set(
    [...groups.querySelectorAll('details.tool-group[open]')].map((d) => d.dataset.tool)
  );
  groups.replaceChildren();
  for (const [tool, data] of Object.entries(store.tools)) {
    const findings = data.findings;
    if (!findings.length) continue;
    const group = document.createElement('details');
    group.className = 'tool-group';
    group.dataset.tool = tool;
    if (openTools.has(tool)) group.open = true;
    const c = (sev) => findings.filter((f) => f.severity === sev).length;
    const summary = document.createElement('summary');
    summary.textContent = `${tool} — ${c('fail')} fail, ${c('warn')} warn, ${c('review')} review`;
    group.appendChild(summary);

    if (findings.some((f) => isRevealable(f.selector))) {
      const actions = document.createElement('div');
      actions.className = 'group-actions';
      const hl = document.createElement('button');
      hl.type = 'button';
      hl.className = 'highlight-all secondary';
      hl.dataset.tool = tool;
      hl.textContent = 'Highlight all';
      hl.title = 'Outline every finding of this checker on the page (no scrolling)';
      actions.appendChild(hl);
      group.appendChild(actions);
    }

    const ul = document.createElement('ul');
    ul.className = 'tool-findings';
    const cap = expandedTools.has(tool) ? findings.length : GROUP_ROW_CAP;
    for (const f of findings.slice(0, cap)) ul.appendChild(findingRow(f));
    group.appendChild(ul);
    if (findings.length > cap) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'show-all secondary';
      more.dataset.tool = tool;
      more.textContent = `Show all ${findings.length}`;
      group.appendChild(more);
    }
    groups.appendChild(group);
  }
}

// -------------------------------------------------- reveal findings on page

async function revealFinding({ selector, severity }) {
  banner('');
  try {
    await inject(REVEAL_FILES, true);
    // All frames: findings are collected allFrames, so the selector may live in
    // an iframe — the highlight lands wherever it matches (a generic selector
    // can match in more than one frame; scrolling inside an iframe scrolls
    // that iframe's viewport, not the top page).
    const results = await pageCall('__a11yOps', 'reveal', [selector, severity], true);
    if (!results.some((r) => r.result === true)) {
      banner('Element not found on the page — it may have been removed or re-rendered. Re-run the checker to refresh findings.');
    }
  } catch (e) {
    checkerError(e);
  }
}

async function highlightAllForTool(tool) {
  banner('');
  try {
    const store = await getStore();
    const items = ((store.tools[tool] && store.tools[tool].findings) || [])
      .filter((f) => isRevealable(f.selector))
      .map((f) => ({ selector: f.selector, severity: f.severity }));
    if (!items.length) return;
    await inject(REVEAL_FILES, true);
    const results = await pageCall('__a11yOps', 'highlight', [items], true);
    const hit = results.reduce((n, r) => n + (r.result || 0), 0);
    announce(`${tool}: highlighted ${Math.min(hit, items.length)} of ${items.length}`);
  } catch (e) {
    checkerError(e);
  }
}

// ------------------------------------------------------------- input watcher

// The watcher's log lives in chrome.storage.session (`watch:${tabId}`, kept
// by the SW across navigations). Each field gets one finding per criterion:
// 3.2.2 (TT 5.D) for a navigation, new tab, submit or script focus move;
// 4.1.2 (TT 5.E) for content shown elsewhere. Every finding is `review`.
const WATCH_WCAG = { navigation: '3.2.2', 'new-tab': '3.2.2', submit: '3.2.2', focus: '3.2.2', content: '4.1.2' };

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function watchSentence(ev) {
  const via = ev.cause ? ` (after ${ev.cause})` : '';
  const named = (t) => `${t.selector}${t.name ? ` ("${clip(t.name, 60)}")` : ''}`;
  switch (ev.kind) {
    case 'navigation':
      // The SW cannot tell a field-caused navigation from the user's own
      // reload, address-bar entry or Back/Forward in the same 5 s.
      return `The page navigated or reloaded${ev.to ? ` to ${ev.to}` : ''}${via}, or the user reloaded or navigated within 5 seconds of the change. Check which.`;
    case 'new-tab':
      return `A new tab or window opened${ev.to ? ` (${ev.to})` : ''}${via}.`;
    case 'submit':
      return `A form was submitted with no Enter key or submit-button click before it${via}.`;
    case 'focus':
      return `A script moved focus to ${named(ev.target)}; no Tab key or click came before it${via}.`;
    case 'content': {
      const text = ev.target.text ? ` ("${clip(ev.target.text, 80)}")` : '';
      const how = ev.focusMoved
        ? 'Focus moved to it.'
        : ev.announced && ev.announced.length
          ? `Focus did not move to it. A live region changed to ${ev.announced.map((a) => `"${clip(a, 80)}"`).join(', ')}.`
          : 'Focus did not move to it, and no live region changed.';
      return `Content was shown or added at ${ev.target.selector}${text}${via}. ${how}`;
    }
    default:
      return '';
  }
}

const WATCH_ADVICE = {
  '3.2.2':
    'WCAG 3.2.2 (TT 5.D): changing a field must not change the context unless the user was told before using it. Check for that advance warning.',
  '4.1.2':
    'TT 5.E (WCAG 4.1.2) passes when the field says what it changes, focus moves to the new content, a dialog tells the user, or the new content is in a live region. Check how the user is told.',
};

function watchFindings(events) {
  const groups = new Map();
  for (const ev of events) {
    const wcag = WATCH_WCAG[ev.kind];
    if (!wcag || !ev.field) continue;
    const key = `${ev.field.selector}|${wcag}`;
    if (!groups.has(key)) groups.set(key, { ev, wcag, events: [] });
    groups.get(key).events.push(ev);
  }
  // One finding per field and criterion (the diff fingerprint is
  // tool|wcag|selector). When the same selector logged changes on more than
  // one page, each sentence names its page; the url column has the first.
  return [...groups.values()].map(({ ev, wcag, events: evs }) => {
    const pages = new Set(evs.map((x) => x.field.url));
    const sentences = new Map();
    for (const x of evs) {
      const s = watchSentence(x) + (pages.size > 1 ? ` (On ${x.field.url}.)` : '');
      sentences.set(s, (sentences.get(s) || 0) + 1);
    }
    const lines = [...sentences].map(([s, n]) => (n > 1 ? `${s} (${n} times)` : s));
    const name = ev.field.name ? ` ("${clip(ev.field.name, 60)}")` : '';
    return {
      tool: 'input-watcher',
      wcag,
      severity: 'review',
      selector: ev.field.selector,
      snippet: ev.field.snippet || '',
      url: ev.field.url,
      details: `After a change on this field${name}: ${lines.join(' ')} ${WATCH_ADVICE[wcag]}`,
    };
  });
}

// Merge the log into this report. Findings already in the report stay (a
// restarted watcher starts a new log), and a field's finding from the log
// replaces its older one.
// state: the log to use (Stop passes the final one); else read from storage.
// final: true only from Stop, which writes the run history.
async function syncWatchFindings(state, { final = false } = {}) {
  if (!tab || restricted) return;
  if (state === undefined) {
    const key = `watch:${tab.id}`;
    state = (await chrome.storage.session.get(key))[key];
  }
  if (!state || !state.events || !state.events.length) return;
  const derived = watchFindings(state.events);
  const store = await getStore();
  const existing = (store.tools['input-watcher'] && store.tools['input-watcher'].findings) || [];
  const fresh = new Set(derived.map(fingerprint));
  const kept = existing.filter((f) => !fresh.has(fingerprint(f)));
  await storeToolFindings('input-watcher', [...kept, ...derived], { final });
}

// ------------------------------------------------------------ checker wiring

// Declarative checker registry: drives both the per-row Run buttons and the
// batch "Run selected" loop. Registry order IS the batch order — auto-update
// watches first, before any checker focuses, styles or hovers the page (those
// can change content, or stop a carousel that pauses on focus or hover);
// text-spacing runs after target-size/reflow (its analyze pass applies the
// override stylesheet, which would skew their measurements) and the slow
// hover probe runs last. The stateful toggles (text-spacing apply/remove, accname
// inspector, live-regions monitor, focus locator, error capture, input
// watcher) are deliberately not batchable and stay outside the registry, as
// does audio's Reload and record (it reloads the page, which would reset
// what the other checkers measure).
const CHECKERS = [
  // Off by default in the batch: it adds the whole watch time to the run.
  { id: 'auto-update', tool: 'auto-update', buttonId: 'run-auto-update', kind: 'auto-update',
    files: [...MECHANISM, LIVE, 'checkers/auto-update.js'],
    batchDefault: false },
  { id: 'motion', tool: 'motion', buttonId: 'run-motion', kind: 'simple',
    files: [...MECHANISM, 'checkers/motion-check.js'], fnName: 'motion', allFrames: true,
    batchDefault: true },
  { id: 'audio', tool: 'audio', buttonId: 'run-audio', kind: 'audio',
    files: [...MECHANISM, 'checkers/audio-check.js'],
    batchDefault: true },
  { id: 'focus-visibility', tool: 'focus-visibility', buttonId: 'run-focus', kind: 'simple',
    files: [OVERLAY, FOCUS_STYLE, 'checkers/focus-walker.js'], fnName: 'focusWalker',
    batchDefault: true },
  { id: 'keyboard-access', tool: 'keyboard-access', buttonId: 'run-keyboard-access', kind: 'keyboard',
    files: [OVERLAY, 'checkers/keyboard-access.js'],
    batchDefault: true },
  { id: 'form-labels', tool: 'form-labels', buttonId: 'run-form-labels', kind: 'simple',
    files: [...FORMS, 'checkers/form-labels.js'], fnName: 'formLabels', allFrames: true,
    batchDefault: true },
  { id: 'tables', tool: 'tables', buttonId: 'run-tables', kind: 'tables',
    files: TABLE_FILES,
    batchDefault: true },
  // Reads layout, so it runs before text-spacing applies its overrides.
  { id: 'css-position', tool: 'css-position', buttonId: 'run-css-position', kind: 'css-position',
    files: CSS_POSITION_FILES,
    batchDefault: true },
  { id: 'target-size', tool: 'target-size', buttonId: 'run-target-size', kind: 'simple',
    files: [OVERLAY, 'checkers/target-size.js'], fnName: 'targetSize', allFrames: true,
    batchDefault: true },
  { id: 'reflow', tool: 'reflow', buttonId: 'run-reflow-scan', kind: 'simple',
    files: ['checkers/reflow-scan.js'], fnName: 'reflowScan',
    gate: () => !!(lastState && lastState.reflow),
    gateHint: 'enable the Reflow test toggle first',
    batchDefault: true },
  { id: 'text-spacing-analyze', tool: 'text-spacing', buttonId: 'run-text-spacing', kind: 'simple',
    files: ['checkers/text-spacing.js'], fnName: 'textSpacing', allFrames: true, arg: 'analyze',
    after: () => { $('toggle-text-spacing').textContent = 'Remove overrides'; },
    // Batch only: the analyze pass leaves the overrides applied (matching the
    // single-button behavior); in a batch we remove them so they can't skew
    // anything and the page is left untouched.
    batchCleanup: async () => {
      await callChecker('textSpacing', 'remove', true);
      $('toggle-text-spacing').textContent = 'Apply overrides';
    },
    batchDefault: true },
  { id: 'hover-static', tool: 'hover-content', buttonId: null, kind: 'hover',
    probe: false, batchDefault: true },
  { id: 'hover-probe', tool: 'hover-content', buttonId: 'run-hover', kind: 'hover',
    probe: true, batchDefault: false },
];

async function execChecker(entry) {
  const allFrames = entry.allFrames === true;
  await inject([...LIBS, ...entry.files], allFrames);
  const results = await callChecker(entry.fnName, entry.arg ?? null, allFrames);
  const merged = results.flatMap((r) => (Array.isArray(r.result) ? r.result : []));
  const { findings } = await storeToolFindings(entry.tool, merged);
  if (entry.after) entry.after();
  return { tool: entry.tool, count: findings.length };
}

async function execHover(entry) {
  let probing = false;
  try {
    await inject([...LIBS, 'checkers/lib/accname.js', 'checkers/hover-content.js']);
    const [top] = await callChecker('hoverStatic');
    const { findings, candidates } = top.result;

    if (candidates.length && !entry.probe) {
      findings.push({
        tool: 'hover-content',
        wcag: '1.4.13',
        severity: 'review',
        selector: '(page)',
        snippet: '',
        details: `${candidates.length} hover/focus-reveal candidates found; the dynamic dismissability probe was skipped (batch static pass). Run the full Hover/focus content checker to verify Escape-dismissability.`,
      });
    } else if (candidates.length) {
      const start = await send({ type: 'hoverProbe', action: 'start' });
      if (!start.ok) {
        findings.push({
          tool: 'hover-content',
          wcag: '1.4.13',
          severity: 'review',
          selector: '(page)',
          snippet: '',
          details: `${candidates.length} hover/focus-reveal candidates were found but the dynamic dismissability probe could not run: ${start.error}`,
        });
      } else {
        probing = true;
        for (const c of candidates) {
          const prep = await hoverCall('prepare', c.index);
          if (!prep || !prep.ok) continue;
          if (prep.kind === 'hover') {
            await send({ type: 'hoverProbe', action: 'move', x: prep.x, y: prep.y });
          }
          await sleep(350);
          const obs = await hoverCall('observe', c.index);
          if (obs && obs.revealed) {
            await send({ type: 'hoverProbe', action: 'escape' });
            await sleep(250);
            const verdict = await hoverCall('verdict', c.index);
            if (verdict && verdict.finding) findings.push(verdict.finding);
          }
          await hoverCall('finish', c.index);
          if (prep.kind === 'hover') {
            await send({ type: 'hoverProbe', action: 'move', x: 0, y: 0 });
            await sleep(120);
          }
        }
      }
    }
    const stored = await storeToolFindings('hover-content', findings);
    return { tool: 'hover-content', count: stored.findings.length };
  } finally {
    if (probing) await send({ type: 'hoverProbe', action: 'end' }).catch(() => {});
  }
}

// Audio (1.4.2): the checker returns { findings, playing } per frame. Chrome's
// tab-level "audible" flag also catches sound the frames can't see (Web Audio,
// cross-origin iframes); it is added as a page-level finding only when no
// frame found an unmuted media element playing.
async function execAudio(entry) {
  await inject([...LIBS, ...entry.files], true);
  const results = await callChecker('audio', null, true);
  const findings = [];
  let playing = 0;
  let hooked = false;
  for (const r of results) {
    if (!r.result || !Array.isArray(r.result.findings)) continue;
    findings.push(...r.result.findings);
    playing += r.result.playing || 0;
    if (r.frameId === 0) hooked = !!r.result.hooked;
  }
  const live = await chrome.tabs.get(tab.id);
  if (live.audible && !playing) {
    const note =
      'Chrome reports that this tab is playing sound, but no unmuted media element in the page is playing. ' +
      'The sound may come from Web Audio or from a cross-origin iframe. Find the source, check whether it started without user action and plays for more than 3 seconds, ' +
      'and if so check for a control within the first three elements (WCAG 1.4.2 / Trusted Tester 2.A).';
    // Keep one '(page)' finding per tool so the diff fingerprint stays unique.
    const page = findings.find((f) => f.selector === '(page)');
    if (page) page.details += ` ${note}`;
    else findings.push({ tool: 'audio', wcag: '1.4.2', severity: 'review', selector: '(page)', snippet: '', details: note });
  }
  const stored = await storeToolFindings('audio', findings);
  return { tool: 'audio', count: stored.findings.length, hooked };
}

// Mouse-only scan (2.1.1 / TT 4.A): the SW reads the page's click listeners
// over CDP first (content scripts cannot see them), then the checker runs in
// every frame with them. Without the listeners the scan still runs on its
// static signals, and one '(page)' note says what was not covered.
async function execKeyboardAccess(entry) {
  const res = await send({ type: 'clickListeners' }).catch((e) => ({ ok: false, error: e.message }));
  await inject([...LIBS, ...entry.files], true);
  const arg = { listenerPaths: res && res.ok ? res.paths : null };
  const results = await callChecker('keyboardAccess', arg, true);
  const all = results.flatMap((r) => (Array.isArray(r.result) ? r.result : []));
  // Each frame that hits the cap returns its own '(page)' note. Merge them
  // (and the listener note below) into one, so the diff fingerprint
  // tool|wcag|(page) stays unique.
  const findings = all.filter((f) => f.selector !== '(page)');
  const pageNotes = all.filter((f) => f.selector === '(page)');
  if (pageNotes.length) {
    findings.push({ ...pageNotes[0], details: [...new Set(pageNotes.map((f) => f.details))].join(' ') });
  }
  let note = '';
  if (!res || !res.ok) {
    note =
      `The page's click listeners could not be read (${(res && res.error) || 'no response'}). ` +
      'Elements whose only sign of being clickable is a script click handler (no pointer cursor, onclick attribute or role) were not checked. ' +
      'Close DevTools on this tab and run the scan again, or check those elements by hand.';
  } else if (res.truncated) {
    note = 'The page has more elements with click listeners than the scan reads; some were not checked by their listeners.';
  }
  if (note) {
    // Keep one '(page)' finding per tool so the diff fingerprint stays unique.
    const page = findings.find((f) => f.selector === '(page)');
    if (page) page.details += ` ${note}`;
    else findings.push({ tool: 'keyboard-access', wcag: '2.1.1', severity: 'review', selector: '(page)', snippet: '', details: note });
  }
  const stored = await storeToolFindings('keyboard-access', findings);
  return { tool: 'keyboard-access', count: stored.findings.length };
}

// Whole seconds from the watch-time field. Empty, zero, negative or
// non-numeric uses the default; a fraction rounds down; capped at the max.
function parseWatchSeconds(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return AUTO_UPDATE_DEFAULT_S;
  return Math.min(n, AUTO_UPDATE_MAX_S);
}

async function initAutoUpdateSeconds() {
  const field = $('auto-update-seconds');
  const stored = (await chrome.storage.local.get('autoUpdateSeconds')).autoUpdateSeconds;
  field.value = String(parseWatchSeconds(stored));
  field.addEventListener('change', async () => {
    const seconds = parseWatchSeconds(field.value);
    field.value = String(seconds);
    await chrome.storage.local.set({ autoUpdateSeconds: seconds });
  });
}

// Auto-update (2.2.2 / TT 2.C, 4.1.2 / TT 2.D): the page watches itself for
// the set time; this page waits it out with a visible countdown, then
// collects. Top frame only. Like Reload and record, it holds the tab: if the
// side panel switches tabs meanwhile, the countdown stops at once and the run
// is abandoned (the page-side watch ends on its own). autoUpdateRunning keeps
// the Run button disabled through the panel's restricted-UI reset, so a
// second run cannot share the countdown. entry.resume: pick up a watch that
// an earlier popup started (see resumeAutoUpdate) instead of starting one.
async function execAutoUpdate(entry) {
  autoUpdateRunning = true;
  $('run-auto-update').disabled = true;
  try {
    return await watchAndCollect(entry);
  } finally {
    autoUpdateRunning = false;
    $('run-auto-update').disabled = restricted;
  }
}

async function watchAndCollect(entry) {
  const watchedTabId = tab.id;
  await inject([...LIBS, ...entry.files]);
  let endAt;
  if (entry.resume) {
    const [st] = await callChecker('autoUpdate', { action: 'status' });
    const status = st.result || {};
    if (!status.active && !status.finished) return { tool: 'auto-update', count: 0, note: 'no earlier watch to collect' };
    endAt = Date.now() + (status.remainingMs || 0);
    announce(
      status.active
        ? `auto-update: a watch started earlier is still running. Results in ${Math.ceil(status.remainingMs / 1000)} seconds. Do not touch the page.`
        : 'auto-update: collecting a watch that ended while no popup was open.'
    );
  } else {
    const seconds = parseWatchSeconds($('auto-update-seconds').value);
    const [start] = await callChecker('autoUpdate', { action: 'start', seconds });
    if (start.result && start.result.busy) {
      throw new Error('Auto-update is already watching this page (from the popup or the side panel). Wait for it to finish.');
    }
    announce(`auto-update: watching the page for ${seconds} seconds. Do not touch the page.`);
    endAt = Date.now() + seconds * 1000;
  }
  const progress = $('auto-update-progress');
  try {
    for (let left = endAt - Date.now(); left > 0 && tab.id === watchedTabId; left = endAt - Date.now()) {
      progress.textContent = `Watching… ${Math.ceil(left / 1000)} s`;
      await sleep(Math.min(250, left));
    }
  } finally {
    progress.textContent = '';
  }
  if (tab.id !== watchedTabId) throw new Error('The tab changed during the auto-update watch. Run it again.');
  // Inject again: if the page navigated, the new document has no checker,
  // and collect must answer "missing" rather than fail on an undefined.
  await inject([...LIBS, ...entry.files]);
  const [res] = await callChecker('autoUpdate', { action: 'collect' });
  if (!res.result || res.result.missing) {
    throw new Error('The page navigated or reloaded during the auto-update watch, so nothing was reported. Run it again.');
  }
  const { findings, watchedMs } = res.result;
  const stored = await storeToolFindings('auto-update', findings);
  return { tool: 'auto-update', count: stored.findings.length, note: `watched ${Math.round(watchedMs / 1000)} seconds` };
}

// ------------------------------------------------------------------- tables

// Tables (1.3.1 / TT section 14). The SW reads Chrome's role for each table
// first (debugger, top document only); then the checker runs in every frame
// with those roles and the tester's saved Data / Layout choices
// (chrome.storage.local `tableClass:${normUrl}`, keyed `${page}|${selector}`).
// draw: the Run button draws the overlay; a batch run and a changed choice
// only scan (the page redraws an overlay that is already on). The last list
// is kept in chrome.storage.session `tables:${tabId}` for the next popup.
const tablesKey = () => `tables:${tab.id}`;
const tableClassKey = () => `tableClass:${normUrl(tab.url)}`;
const TABLES_ENTRY = () => CHECKERS.find((c) => c.id === 'tables');
// The stamp of the list this page stored last. The side panel re-renders a
// list that the popup stored, but not its own (that would drop focus from
// the radio button just changed).
let ownTablesStamp = null;

async function execTables(entry, { draw = true } = {}) {
  const ax = await send({ type: 'tableAX' }).catch((e) => ({ ok: false, error: e.message }));
  const overrides = (await chrome.storage.local.get(tableClassKey()))[tableClassKey()] || {};
  await inject([...LIBS, ...entry.files], true);
  const arg = {
    action: draw ? 'show' : 'scan',
    axTables: ax && ax.ok ? ax.tables : null,
    axError: ax && ax.ok ? null : (ax && ax.error) || 'no response',
    overrides,
  };
  const results = await callChecker('tables', arg, true);
  const tables = [];
  const findings = [];
  let failed = 0;
  for (const r of results) {
    // A null result is a frame whose checker threw (the exec route nulls a
    // subframe error), not a frame with no tables.
    if (!r.result) {
      failed++;
      continue;
    }
    tables.push(...(r.result.tables || []));
    findings.push(...(r.result.findings || []));
  }
  if (failed) {
    findings.push({
      tool: 'tables', wcag: '1.3.1', severity: 'review', selector: '(page)', snippet: '',
      details: `The Tables check failed in ${failed} frame${failed === 1 ? '' : 's'}, so tables there were not checked. Check the tables in those frames by hand (WCAG 1.3.1, TT section 14).`,
    });
  }
  let note = '';
  if (!ax || !ax.ok) {
    note =
      `Chrome's role for each table could not be read (${(ax && ax.error) || 'no response'}), so the data or layout guess does not use it and no finding checks it. ` +
      'Close DevTools on this tab and run the check again.';
  } else if (ax.truncated) {
    note = 'The page has more tables than the tool reads Chrome roles for. Some tables have no Chrome role.';
  }
  if (note && tables.length) {
    findings.push({ tool: 'tables', wcag: '1.3.1', severity: 'review', selector: '(page)', snippet: '', details: note });
  }
  ownTablesStamp = `${Date.now()}-${Math.random()}`;
  await chrome.storage.session.set({ [tablesKey()]: { url: tab.url, tables, stamp: ownTablesStamp } });
  renderTables(tables);
  const stored = await storeToolFindings('tables', findings);
  if (draw) $('toggle-tables-overlay').textContent = 'Hide overlay';
  return { tool: 'tables', count: stored.findings.length, note: `${tables.length} table${tables.length === 1 ? '' : 's'}`, tables };
}

const CLASS_NAMES = { data: 'Data', layout: 'Layout', unsure: 'Unsure' };

function chromeText(c) {
  switch (c.status) {
    case 'ok':
      return `Chrome: ${c.role}`;
    case 'frame':
      return 'Chrome: not read (in a frame)';
    case 'error':
      return 'Chrome: not read (see the page note)';
    case 'missing':
      return 'Chrome: not found';
    default:
      return 'Chrome: not read';
  }
}

// One list item per table. Rebuilt on every run; `focus` puts focus back on
// the radio button that was just changed.
function renderTables(tables, focus = null) {
  const panel = $('tables-panel');
  const list = $('tables-list');
  if (!tables) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }
  panel.hidden = false;
  const counts = { data: 0, layout: 0, unsure: 0 };
  for (const t of tables) counts[t.cls]++;
  $('tables-summary').textContent = tables.length
    ? `${tables.length} table${tables.length === 1 ? '' : 's'}: ${counts.data} data, ${counts.layout} layout, ${counts.unsure} not decided.`
    : 'No tables found on this page.';
  list.replaceChildren();
  tables.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'table-item';

    const line = document.createElement('div');
    line.className = 'table-line';
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'table-reveal secondary';
    reveal.dataset.selector = t.selector;
    reveal.dataset.severity = t.severity || 'review';
    reveal.textContent = t.label;
    reveal.title = `Scroll to and highlight ${t.label} (${t.selector})`;
    const cls = document.createElement('strong');
    cls.textContent = `${CLASS_NAMES[t.cls]}${t.confirmed ? ' (your choice)' : " (tool's guess)"}`;
    line.append(reveal, cls);
    if (t.severity) {
      const sev = document.createElement('span');
      sev.className = `sev sev-${t.severity}`;
      sev.textContent = t.severity;
      line.appendChild(sev);
    }
    li.appendChild(line);

    const facts = document.createElement('p');
    facts.className = 'table-facts';
    facts.textContent = `${t.rows} × ${t.cols}${t.kind === 'aria' ? ' (ARIA)' : ''} · ${chromeText(t.chrome)}`;
    li.appendChild(facts);

    // The tester's choice. "Tool's guess" removes a saved choice.
    const group = document.createElement('fieldset');
    group.className = 'table-class';
    const legend = document.createElement('legend');
    legend.textContent = `${t.label} is a`;
    group.appendChild(legend);
    const options = [
      ['auto', `Tool's guess (${CLASS_NAMES[t.guess]})`],
      ['data', 'Data table'],
      ['layout', 'Layout table'],
    ];
    for (const [value, text] of options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `table-class-${i}`;
      input.value = value;
      input.dataset.key = t.key;
      input.checked = (t.confirmed || 'auto') === value;
      label.append(input, ` ${text}`);
      group.appendChild(label);
    }
    li.appendChild(group);

    if (t.issues.length) {
      const ul = document.createElement('ul');
      ul.className = 'table-issues';
      for (const issue of t.issues) {
        const item = document.createElement('li');
        item.textContent = `${issue.severity}: ${issue.text}`;
        ul.appendChild(item);
      }
      li.appendChild(ul);
    }

    const evidence = document.createElement('details');
    evidence.className = 'table-evidence';
    const sum = document.createElement('summary');
    sum.textContent = 'Why the tool guessed this';
    const ev = document.createElement('ul');
    for (const [side, items] of [['Signs of data', t.signals.data], ['Signs of layout', t.signals.layout]]) {
      const item = document.createElement('li');
      item.textContent = `${side}: ${items.length ? items.join(', ') : 'none'}.`;
      ev.appendChild(item);
    }
    evidence.append(sum, ev);
    li.appendChild(evidence);

    const check = document.createElement('p');
    check.className = 'table-check';
    check.textContent = t.check;
    li.appendChild(check);

    list.appendChild(li);
  });
  if (focus) {
    const again = [...list.querySelectorAll('input[type="radio"]')].find(
      (r) => r.dataset.key === focus.key && r.value === focus.value
    );
    if (again) again.focus();
  }
}

async function renderStoredTables() {
  const stored = (await chrome.storage.session.get(tablesKey()))[tablesKey()];
  renderTables(stored && normUrl(stored.url) === normUrl(tab.url) ? stored.tables : null);
}

// Save the tester's Data / Layout choice ('auto' removes it), then check
// again so the findings and the overlay use it.
async function setTableClass(key, value) {
  const k = tableClassKey();
  const all = (await chrome.storage.local.get(k))[k] || {};
  if (value === 'auto') delete all[key];
  else all[key] = value;
  if (Object.keys(all).length) await chrome.storage.local.set({ [k]: all });
  else await chrome.storage.local.remove(k);
  const { count, tables } = await execTables(TABLES_ENTRY(), { draw: false });
  renderTables(tables, { key, value });
  announce(`tables: saved. ${count} findings.`);
}

async function refreshTablesButton(markers = pageMarkers()) {
  try {
    const m = await markers;
    $('toggle-tables-overlay').textContent = m.tables ? 'Hide overlay' : 'Show overlay';
  } catch {
    // leave default label
  }
}

// ---------------------------------------------------------- CSS positioning

// CSS positioning (1.3.2 / TT 15.B). Run draws the overlay (own layer, marker
// data-a11y-css-position, not removed by Clear overlays); a batch run only
// scans, and redraws an overlay that is on. Linearize is page-side state
// (marker data-a11y-linearize); every frame runs it.
async function execCssPosition(entry, { draw = true } = {}) {
  await inject([...LIBS, ...entry.files], true);
  const results = await callChecker('cssPosition', { action: draw ? 'show' : 'scan' }, true);
  let moved = 0;
  let changed = 0;
  let failed = 0;
  const findings = [];
  for (const r of results) {
    // A null result is a frame whose checker threw (the exec route nulls a
    // subframe error), not a frame with nothing moved.
    if (!r.result) {
      failed++;
      continue;
    }
    moved += r.result.items.length;
    changed += r.result.items.filter((i) => i.order === 'changed').length;
    findings.push(...r.result.findings);
  }
  if (failed) {
    findings.push({
      tool: 'css-position', wcag: '1.3.2', severity: 'review', selector: '(page)', snippet: '',
      details: `The CSS positioning check failed in ${failed} frame${failed === 1 ? '' : 's'}, so content positioned with CSS there was not checked. Check the reading order in those frames by hand (WCAG 1.3.2, TT 15.B).`,
    });
  }
  const stored = await storeToolFindings('css-position', findings);
  if (draw) $('toggle-css-position-overlay').textContent = 'Hide overlay';
  return { tool: 'css-position', count: stored.findings.length, note: `${moved} moved, ${changed} out of reading order` };
}

async function refreshCssPositionButtons(markers = pageMarkers()) {
  try {
    const m = await markers;
    $('toggle-css-position-overlay').textContent = m.cssPosition ? 'Hide overlay' : 'Show overlay';
    $('toggle-css-linearize').textContent = m.linearize ? 'Undo linearize' : 'Linearize';
  } catch {
    // leave default labels
  }
}

function execEntry(entry, opts = {}) {
  if (entry.kind === 'hover') return execHover(entry);
  if (entry.kind === 'audio') return execAudio(entry);
  if (entry.kind === 'keyboard') return execKeyboardAccess(entry);
  if (entry.kind === 'auto-update') return execAutoUpdate(entry);
  if (entry.kind === 'tables') return execTables(entry, { draw: !opts.batch });
  if (entry.kind === 'css-position') return execCssPosition(entry, { draw: !opts.batch });
  return execChecker(entry);
}

async function runFromButton(button, entry) {
  button.disabled = true;
  banner('');
  try {
    const { tool, count, note } = await execEntry(entry);
    announce(`${tool}: ${count} findings${note ? ` (${note})` : ''}`);
  } catch (e) {
    checkerError(e);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------- batch running

async function initBatchSelection() {
  const stored = (await chrome.storage.local.get('batchSelection')).batchSelection || {};
  for (const box of document.querySelectorAll('.batch-select')) {
    const id = box.dataset.batchId;
    const entry = CHECKERS.find((c) => c.id === id);
    if (!entry) {
      // data-batch-id in popup.html and CHECKERS[].id are a hand-synced pair.
      console.warn(`Batch checkbox has no matching CHECKERS entry: ${id}`);
      continue;
    }
    box.checked = Object.prototype.hasOwnProperty.call(stored, id)
      ? !!stored[id]
      : !!entry.batchDefault;
    box.addEventListener('change', async () => {
      const cur = (await chrome.storage.local.get('batchSelection')).batchSelection || {};
      cur[id] = box.checked;
      await chrome.storage.local.set({ batchSelection: cur });
    });
  }
}

async function runBatch() {
  const btn = $('run-selected');
  btn.disabled = true;
  banner('');
  const selected = new Set(
    [...document.querySelectorAll('.batch-select')]
      .filter((b) => b.checked && !b.disabled)
      .map((b) => b.dataset.batchId)
  );
  // The full probe runs the static pass itself — don't do it twice.
  if (selected.has('hover-probe')) selected.delete('hover-static');
  const queue = CHECKERS.filter((e) => selected.has(e.id));
  if (!queue.length) {
    banner('Nothing selected — tick the checkbox on at least one checker.');
    btn.disabled = false;
    return;
  }
  const errors = [];
  let total = 0;
  let ran = 0;
  let i = 0;
  for (const entry of queue) {
    $('batch-progress').textContent = `${++i}/${queue.length}: ${entry.tool}…`;
    if (entry.gate && !entry.gate()) {
      errors.push(`${entry.tool}: skipped — ${entry.gateHint || 'not available'}`);
      continue;
    }
    try {
      const { count } = await execEntry(entry, { batch: true });
      total += count;
      ran++;
      if (entry.batchCleanup) await entry.batchCleanup();
    } catch (e) {
      errors.push(`${entry.tool}: ${e && e.message ? e.message : e}`);
    }
  }
  $('batch-progress').textContent = '';
  announce(
    `Batch complete: ${total} findings across ${ran} checker${ran === 1 ? '' : 's'}` +
      (errors.length ? `; ${errors.length} skipped/failed` : '')
  );
  if (errors.length) banner(errors.join(' · '));
  btn.disabled = false;
}

async function refreshTextSpacingButton() {
  try {
    await inject([...LIBS, 'checkers/text-spacing.js']);
    const [res] = await callChecker('textSpacing', 'status');
    $('toggle-text-spacing').textContent = res.result.applied ? 'Remove overrides' : 'Apply overrides';
    return res.result.applied;
  } catch {
    return false;
  }
}

async function refreshAccnameButton(markers = pageMarkers()) {
  try {
    const m = await markers;
    $('toggle-accname').textContent = m.accname ? 'Stop inspector' : 'Start inspector';
  } catch {
    // leave default label
  }
}

async function refreshFocusLocatorButton(markers = pageMarkers()) {
  try {
    const m = await markers;
    $('toggle-focus-locator').textContent = m.focusLocator ? 'Stop locator' : 'Start locator';
  } catch {
    // leave default label
  }
}

// Error capture keeps its results page-side. A capture window that closed
// while no popup or panel was open is picked up here.
async function refreshErrorCaptureButton() {
  try {
    await inject([OPS]);
    const [res] = await pageCall('__a11yOps', 'errorCaptureState');
    const state = res.result;
    $('toggle-error-capture').textContent = state && state.active ? 'Stop capture' : 'Start capture';
    if (state && state.captures) await storeToolFindings('error-capture', state.findings, { final: false });
  } catch {
    // leave default label
  }
}

// "Resume" when the SW still holds an active log but the page script is gone
// (the page navigated): starting again continues the same log.
async function refreshInputWatcherButton(markers = pageMarkers()) {
  const key = `watch:${tab.id}`;
  const sw = (await chrome.storage.session.get(key))[key];
  const idle = sw && sw.active ? 'Resume watcher' : 'Start watcher';
  try {
    const m = await markers;
    $('toggle-input-watcher').textContent = m.inputWatcher ? 'Stop watcher' : idle;
  } catch {
    // No access to the page (side panel after a tab switch): the SW log still
    // says whether a session is open, so the label never keeps another tab's.
    $('toggle-input-watcher').textContent = idle;
  }
}

// A popup closes when the tester clicks the page, which kills its Auto-update
// countdown. The page keeps watching and marks the watch (data-a11y-auto-update);
// the next popup or panel refresh resumes the countdown, or collects the
// watch at once if it has ended.
async function resumeAutoUpdate(markers) {
  if (autoUpdateRunning) return;
  const tabId = tab.id;
  let m;
  try {
    m = await markers;
  } catch {
    return;
  }
  // The markers belong to tabId; the side panel may have switched since.
  if (!m || !m.autoUpdate || autoUpdateRunning || tab.id !== tabId) return;
  runFromButton($('run-auto-update'), { ...CHECKERS.find((c) => c.id === 'auto-update'), resume: true });
}

async function refreshLiveRegionsButton(markers = pageMarkers()) {
  try {
    const m = await markers;
    $('toggle-live-regions').textContent = m.liveMonitor ? 'Stop monitor' : 'Start monitor';
  } catch {
    // leave default label
  }
}

function wireCheckers() {
  for (const entry of CHECKERS) {
    if (!entry.buttonId) continue;
    const btn = $(entry.buttonId);
    btn.addEventListener('click', () => runFromButton(btn, entry));
  }

  $('run-selected').addEventListener('click', runBatch);

  // Reload and record: the SW installs a page-world hook, reloads the tab and
  // waits for the load; then the audio checker runs with the hook's records.
  // While it runs, recordingAudio keeps the button disabled through the side
  // panel's restricted-UI reset and skips the panel's reload refresh (the run
  // re-syncs the labels itself when it ends). It also holds `tab` fixed: a tab
  // switch in the side panel is deferred until the run ends, so the reload and
  // the checker always target the same tab. No injection carries the click's
  // gesture (they all go through the SW), so the checker runs as soon as the
  // page has settled.
  $('record-audio').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const recordedTabId = tab.id;
    recordingAudio = true;
    btn.disabled = true;
    banner('');
    try {
      announce('audio: reloading the page with recording hooks…');
      const res = await send({ type: 'recordAudio' });
      if (!res || !res.ok) {
        banner(res && res.error ? res.error : 'Could not reload the page with recording hooks.');
        return;
      }
      await sleep(RECORD_SETTLE_MS);
      if (tab.id !== recordedTabId) throw new Error('The tab changed during Reload and record. Run it again.');
      const { count, hooked } = await execAudio(CHECKERS.find((c) => c.id === 'audio'));
      announce(`audio: ${count} findings after a recorded reload`);
      const problems = [];
      if (!hooked) problems.push('The recorder did not run on this page, so these are static results only (script-started audio is not covered). Try Reload and record again.');
      if (!res.loaded) problems.push('The page did not finish loading within 30 seconds. The recorded results may be incomplete.');
      if (problems.length) banner(problems.join(' '));
      // The reload reset page-side tool state; re-sync the toggle labels.
      refreshTextSpacingButton();
      const markers = pageMarkers();
      refreshAccnameButton(markers);
      refreshLiveRegionsButton(markers);
      refreshFocusLocatorButton(markers);
      refreshErrorCaptureButton();
      refreshInputWatcherButton(markers);
      refreshTablesButton(markers);
      refreshCssPositionButtons(markers);
    } catch (err) {
      checkerError(err);
    } finally {
      recordingAudio = false;
      btn.disabled = false;
      if (tabSwitchedWhileRecording) {
        tabSwitchedWhileRecording = false;
        refreshForActiveTab();
      }
    }
  });

  // Tables overlay: Show runs the check and draws; Hide removes the overlay
  // in every frame. Ask the page, not the label (popup and side panel).
  $('toggle-tables-overlay').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    banner('');
    try {
      const markers = await pageMarkers();
      if (markers.tables) {
        await inject([...LIBS, ...TABLE_FILES], true);
        await callChecker('tables', { action: 'hide' }, true);
        btn.textContent = 'Show overlay';
        announce('tables: overlay off.');
      } else {
        const { count, note } = await execTables(TABLES_ENTRY());
        announce(`tables: ${count} findings (${note}); overlay on.`);
      }
    } catch (err) {
      checkerError(err);
    } finally {
      btn.disabled = false;
    }
  });

  // CSS positioning overlay: Show runs the check and draws; Hide removes the
  // overlay (and ends Linearize) in every frame.
  $('toggle-css-position-overlay').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    banner('');
    try {
      const markers = await pageMarkers();
      if (markers.cssPosition) {
        await inject([...LIBS, ...CSS_POSITION_FILES], true);
        await callChecker('cssPosition', { action: 'hide' }, true);
        btn.textContent = 'Show overlay';
        $('toggle-css-linearize').textContent = 'Linearize';
        announce('css-position: overlay off.');
      } else {
        const { count, note } = await execCssPosition(CHECKERS.find((c) => c.id === 'css-position'));
        announce(`css-position: ${count} findings (${note}); overlay on.`);
      }
    } catch (err) {
      checkerError(err);
    } finally {
      btn.disabled = false;
    }
  });

  // Linearize: on also draws the overlay, so the outlines follow the content
  // to its reading-order place.
  $('toggle-css-linearize').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    banner('');
    try {
      const markers = await pageMarkers();
      const on = !markers.linearize;
      if (on && !markers.cssPosition) await execCssPosition(CHECKERS.find((c) => c.id === 'css-position'));
      else await inject([...LIBS, ...CSS_POSITION_FILES], true);
      await callChecker('cssPosition', { action: 'linearize', on }, true);
      btn.textContent = on ? 'Undo linearize' : 'Linearize';
      announce(on ? 'css-position: page linearized. Moved content now shows in reading order.' : 'css-position: linearize off.');
    } catch (err) {
      checkerError(err);
    } finally {
      btn.disabled = false;
    }
  });

  $('tables-list').addEventListener('click', (e) => {
    const reveal = e.target.closest('.table-reveal');
    if (reveal) revealFinding({ selector: reveal.dataset.selector, severity: reveal.dataset.severity });
  });

  $('tables-list').addEventListener('change', async (e) => {
    const input = e.target.closest('input[type="radio"]');
    if (!input || !input.checked) return;
    banner('');
    try {
      await setTableClass(input.dataset.key, input.value);
    } catch (err) {
      checkerError(err);
    }
  });

  $('toggle-text-spacing').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject([...LIBS, 'checkers/text-spacing.js'], true);
      const applied = (await callChecker('textSpacing', 'status'))[0].result.applied;
      await callChecker('textSpacing', applied ? 'remove' : 'apply', true);
      e.target.textContent = applied ? 'Apply overrides' : 'Remove overrides';
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  $('toggle-accname').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject([...LIBS, 'checkers/lib/accname.js', 'checkers/accname-inspector.js']);
      const starting = e.target.textContent.startsWith('Start');
      const [res] = await callChecker('accnameInspector', starting ? 'start' : 'stop');
      if (starting) {
        const { findings } = await storeToolFindings('accname', res.result.findings);
        announce(`accname: ${findings.length} findings; inspector active — hover the page, Escape to exit`);
        e.target.textContent = 'Stop inspector';
      } else {
        e.target.textContent = 'Start inspector';
      }
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  // Focus locator: watches focus while the tester presses Tab by hand.
  $('toggle-focus-locator').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject(LOCATOR_FILES);
      // Ask the page, not the button label: the popup and the side panel can
      // both be open, and the other one may have started or stopped it.
      const [status] = await callChecker('focusLocator', 'status');
      const starting = !status?.result?.active;
      await callChecker('focusLocator', starting ? 'start' : 'stop');
      e.target.textContent = starting ? 'Stop locator' : 'Start locator';
      announce(
        starting
          ? 'focus locator: on. Click the page, then press Tab; the outline follows focus.'
          : 'focus locator: off.'
      );
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  // Error capture: records what the form shows after the tester submits.
  // Results arrive as errorCaptureUpdate messages (wired in init); Stop
  // stores the final set before it removes the capture.
  $('toggle-error-capture').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject(ERROR_FILES);
      // Ask the page, not the button label (the popup and the side panel can
      // both be open).
      const [status] = await callChecker('errorCapture', 'status');
      const starting = !status?.result?.active;
      if (starting) {
        const [res] = await callChecker('errorCapture', 'start');
        e.target.textContent = 'Stop capture';
        announce(
          `error capture: on, ${res.result.fields} fields recorded. Type bad data and submit the form yourself; ` +
            'the capture records what the page shows.'
        );
      } else {
        const [res] = await callChecker('errorCapture', 'collect');
        if (status.result.captures) await storeToolFindings('error-capture', res.result); // final
        await callChecker('errorCapture', 'stop');
        e.target.textContent = 'Start capture';
        announce('error capture: off.');
      }
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  // Input watcher: logs what the tester's own field changes cause. The SW
  // keeps the log (it outlives a navigation); the page script reports to it.
  $('toggle-input-watcher').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject(WATCH_FILES);
      const [status] = await callChecker('inputWatcher', 'status');
      const starting = !status?.result?.active;
      if (starting) {
        const res = await send({ type: 'inputWatch', action: 'start' });
        if (!res || !res.ok) throw new Error((res && res.error) || 'The service worker did not start the watcher.');
        await callChecker('inputWatcher', 'start');
        e.target.textContent = 'Stop watcher';
        const logged = res.state.events.length;
        announce(
          `input watcher: on${logged ? `, continuing a log of ${logged} change${logged === 1 ? '' : 's'}` : ''}. ` +
            'Change the fields yourself and tab away; each effect a change causes is logged.'
        );
        await syncWatchFindings();
      } else {
        // The page's open window (a change less than 1 s ago) goes to the SW
        // with the stop message, so it is in the final log.
        const [res] = await callChecker('inputWatcher', 'stop');
        const sw = await send({ type: 'inputWatch', action: 'stop', events: (res.result && res.result.events) || [] });
        await syncWatchFindings(sw && sw.ok ? sw.state : undefined, { final: true });
        e.target.textContent = 'Start watcher';
        announce('input watcher: off. Its findings stay in the report.');
      }
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  $('toggle-live-regions').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await inject(LIVE_FILES);
      const starting = e.target.textContent.startsWith('Start');
      const [res] = await callChecker('liveRegions', starting ? 'start' : 'stop');
      if (starting) {
        const { findings } = await storeToolFindings('live-regions', res.result.findings);
        announce(
          `live-regions: monitoring ${findings.length} region${findings.length === 1 ? '' : 's'} — ` +
            'interact with the page; the on-page log panels update live'
        );
        e.target.textContent = 'Stop monitor';
      } else {
        e.target.textContent = 'Start monitor';
        announce('live-regions: monitor stopped; its log has been discarded.');
      }
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });

  $('export-live-log').addEventListener('click', async () => {
    try {
      await inject(LIVE_FILES);
      const [res] = await callChecker('liveRegions', 'export');
      const rows = res.result || [];
      if (!rows.length) {
        banner('No announcements logged yet — start the monitor and trigger page updates first. (Stopping the monitor discards its log.)');
        return;
      }
      for (const r of rows) r.url = tab.url;
      let host = 'page';
      try {
        host = new URL(tab.url).hostname || 'page';
      } catch {
        // keep default
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadTable(LIVE_LOG_COLUMNS, rows, `a11y-live-log-${host}-${stamp}.csv`, {
        url: tab.url,
        exported: new Date().toISOString(),
      });
    } catch (e) {
      checkerError(e);
    }
  });

  $('clear-overlays').addEventListener('click', async () => {
    try {
      await inject([OVERLAY, OPS], true);
      await pageCall('__a11yOps', 'clearOverlays', [], true);
    } catch (e) {
      checkerError(e);
    }
  });

  // Full reset: every artifact a checker leaves on the page (overlay layer,
  // text-spacing override stylesheet, live accname inspector, live-region log
  // panels, focus locator, Tables overlay, CSS positioning overlay and
  // linearize, error capture, input watcher and
  // its SW log), plus this tab's stored findings and Tables list (the saved
  // Data / Layout choices stay). Motion/reflow/
  // hover leave nothing behind.
  $('clear-all-checkers').addEventListener('click', async (e) => {
    e.target.disabled = true;
    banner('');
    try {
      // The SW log first: it needs no page access, so a failed injection
      // below cannot leave it behind.
      await send({ type: 'inputWatch', action: 'stop' });
      await inject([OVERLAY, OPS], true);
      await pageCall('__a11yOps', 'clearOverlays', [], true);
      await inject([...LIBS, 'checkers/text-spacing.js'], true);
      await callChecker('textSpacing', 'remove', true);
      $('toggle-text-spacing').textContent = 'Apply overrides';
      await inject([...LIBS, 'checkers/lib/accname.js', 'checkers/accname-inspector.js']);
      await callChecker('accnameInspector', 'stop');
      $('toggle-accname').textContent = 'Start inspector';
      await inject(LIVE_FILES);
      await callChecker('liveRegions', 'stop');
      $('toggle-live-regions').textContent = 'Start monitor';
      await inject(LOCATOR_FILES);
      await callChecker('focusLocator', 'stop');
      $('toggle-focus-locator').textContent = 'Start locator';
      await inject([...LIBS, ...TABLE_FILES], true);
      await callChecker('tables', { action: 'hide' }, true);
      $('toggle-tables-overlay').textContent = 'Show overlay';
      await inject([...LIBS, ...CSS_POSITION_FILES], true);
      await callChecker('cssPosition', { action: 'hide' }, true);
      $('toggle-css-position-overlay').textContent = 'Show overlay';
      $('toggle-css-linearize').textContent = 'Linearize';
      // Error capture and the Input watcher: inject only when the page says
      // one is running.
      const running = await pageMarkers();
      if (running.errorCapture) {
        await inject(ERROR_FILES);
        await callChecker('errorCapture', 'stop');
      }
      $('toggle-error-capture').textContent = 'Start capture';
      if (running.inputWatcher) {
        await inject(WATCH_FILES);
        await callChecker('inputWatcher', 'stop');
      }
      $('toggle-input-watcher').textContent = 'Start watcher';
      await clearFindingsStore();
      announce('Cleared overlays, spacing overrides, inspectors, and findings for this tab.');
    } catch (err) {
      checkerError(err);
    } finally {
      e.target.disabled = false;
    }
  });
}

// -------------------------------------------------------------- report wiring

function wireReport() {
  // One delegated listener — finding rows are re-rendered on every run.
  $('findings-groups').addEventListener('click', (e) => {
    const reveal = e.target.closest('.finding-reveal');
    if (reveal) {
      revealFinding({ selector: reveal.dataset.selector, severity: reveal.dataset.severity });
      return;
    }
    const hl = e.target.closest('.highlight-all');
    if (hl) {
      highlightAllForTool(hl.dataset.tool);
      return;
    }
    const more = e.target.closest('.show-all');
    if (more) {
      expandedTools.add(more.dataset.tool);
      if (lastStore) renderReport(lastStore);
    }
  });

  $('export-csv').addEventListener('click', async () => {
    const store = await getStore();
    const { current, resolved } = allFindings(store);
    const rows = [...current, ...resolved];
    if (!rows.length) {
      banner('Nothing to export yet — run a checker first.');
      return;
    }
    let host = 'page';
    try {
      host = new URL(store.url).hostname || 'page';
    } catch {
      // keep default
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadCsv(rows, `a11y-findings-${host}-${stamp}.csv`, {
      url: store.url,
      exported: new Date().toISOString(),
    });
  });

  $('clear-findings').addEventListener('click', clearFindingsStore);

  $('clear-history').addEventListener('click', async () => {
    const prefix = `history:${normUrl(tab.url)}:`;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
    if (keys.length) await chrome.storage.local.remove(keys);
    announce(`Cleared ${keys.length} stored run(s) for this URL.`);
  });
}

// ----------------------------------------------------------------------- init

// Reversible restricted-page UI (the panel moves between tabs, so a one-way
// disable is not enough).
function setRestrictedUI(on) {
  $('restricted-msg').hidden = !on;
  for (const el of document.querySelectorAll('input, button')) el.disabled = on;
  if (!on) {
    // Re-apply state-dependent disables the blanket enable just cleared;
    // renderState corrects these again as soon as fresh state arrives.
    const reflowOn = !!(lastState && lastState.reflow);
    $('run-reflow-scan').disabled = !reflowOn;
    const reflowBatchBox = document.querySelector('.batch-select[data-batch-id="reflow"]');
    if (reflowBatchBox) reflowBatchBox.disabled = !reflowOn;
    $('record-audio').disabled = recordingAudio;
    $('run-auto-update').disabled = autoUpdateRunning;
  }
}

// Re-resolves the active tab and re-renders everything that is per-tab. The
// popup runs this once; the side panel re-runs it on tab switch/navigation.
let refreshToken = 0;

async function refreshForActiveTab() {
  const token = ++refreshToken; // last-wins guard against rapid tab switches
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (token !== refreshToken) return;
  tab = active;
  restricted = isRestricted(tab && tab.url);
  setRestrictedUI(restricted);

  // Clear per-tab UI before any early return — a switch to a restricted tab
  // must not leave the previous tab's findings on screen.
  banner('');
  for (const id of Object.values(BADGE_BY_TOOL)) $(id).hidden = true;
  $('batch-progress').textContent = '';
  renderReport({ url: tab && tab.url, tools: {} });
  renderTables(null);
  if (restricted) return;

  const res = await send({ type: 'getState' });
  if (token !== refreshToken) return;
  if (res && res.ok) renderState(res.state, res.caps);
  const store = await getStore();
  if (token !== refreshToken) return;
  renderReport(store);
  await renderStoredTables();
  if (token !== refreshToken) return;
  refreshTextSpacingButton();
  // One read of the page markers for every label (and a watch to resume).
  const markers = pageMarkers();
  refreshAccnameButton(markers);
  refreshLiveRegionsButton(markers);
  refreshFocusLocatorButton(markers);
  refreshErrorCaptureButton();
  refreshInputWatcherButton(markers);
  refreshTablesButton(markers);
  refreshCssPositionButtons(markers);
  resumeAutoUpdate(markers);
  // Catch up on watcher entries logged while no popup was open (a
  // navigation, for example).
  syncWatchFindings().catch(() => {});
}

async function init() {
  if (IS_PANEL) document.documentElement.classList.add('panel');

  try {
    wireEmulation();
    wireCheckers();
    wireReport();
    $('open-side-panel').hidden = IS_PANEL;
    if (!IS_PANEL) {
      $('open-side-panel').addEventListener('click', () => {
        // Must run synchronously in the click handler (user-gesture rule).
        chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      });
    }
  } catch (e) {
    // A wiring failure (e.g. stale cached popup.js against a newer
    // popup.html) would otherwise leave every button dead with no clue.
    banner(`Popup failed to initialize: ${e.message}. Reload the extension at chrome://extensions and reopen.`);
    throw e;
  }

  await refreshForActiveTab();
  initBatchSelection(); // once — the selection is a user preference, not per-tab
  initAutoUpdateSeconds(); // likewise

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'stateChanged' && tab && msg.tabId === tab.id) {
      renderState(msg.state, null);
      if (msg.reason) banner(msg.reason);
    }
    // Posted by the page's Error capture after each capture window.
    if (
      msg && msg.type === 'errorCaptureUpdate' && tab && !restricted &&
      sender.tab && sender.tab.id === tab.id && Array.isArray(msg.findings)
    ) {
      storeToolFindings('error-capture', msg.findings, { final: false }).then(({ findings }) =>
        announce(`error capture: ${findings.length} field${findings.length === 1 ? '' : 's'} with an error so far`)
      );
    }
  });

  // The Input watcher's log grows in session storage (SW-written); fold each
  // new entry into the report while this popup or panel is open. Marks
  // (one per keystroke) change `last`, not `seq`, and are skipped.
  chrome.storage.session.onChanged.addListener((changes) => {
    const c = tab && changes[`watch:${tab.id}`];
    if (!c || restricted) return;
    // seq, not the length: the log is capped, so its length stops changing.
    const seq = (v) => (v && v.seq) || 0;
    if (seq(c.newValue) && seq(c.newValue) !== seq(c.oldValue)) syncWatchFindings().catch(() => {});
  });

  if (IS_PANEL) {
    chrome.tabs.onActivated.addListener(() => {
      // Deferred during Reload and record, which must keep targeting its tab.
      if (recordingAudio) {
        tabSwitchedWhileRecording = true;
        return;
      }
      refreshForActiveTab();
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      // Fires for every tab — only react to the one this panel tracks.
      // Skipped during Reload and record, which re-syncs when it ends.
      if (recordingAudio) return;
      if (tab && tabId === tab.id && (info.status === 'complete' || info.url)) {
        refreshForActiveTab();
      }
    });
    // Checkers run from the popup while the panel is open should update the
    // panel's report too. Shared storage is last-write-wins by design.
    chrome.storage.session.onChanged.addListener((changes) => {
      if (tab && changes[`findings:${tab.id}`] && !restricted) {
        getStore().then(renderReport);
      }
      const t = tab && changes[`tables:${tab.id}`];
      if (t && !restricted && !(t.newValue && t.newValue.stamp === ownTablesStamp)) {
        renderStoredTables();
      }
    });
  }
}

init();
