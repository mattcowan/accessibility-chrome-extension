// Popup: emulation controls (via the service worker / CDP), checker runner
// (direct chrome.scripting injection under activeTab), findings store with
// run-over-run diff, and CSV export. The same page also serves as the Chrome
// side panel (?context=panel), where it additionally tracks the active tab.

import { downloadCsv, downloadTable } from './csv.js';

const LIBS = ['checkers/lib/selector.js', 'checkers/lib/findings.js'];
const OVERLAY = 'checkers/lib/overlay.js';
// Mechanism finder for auto-playing content (TT 2.A / 2.B); needs accname.
const MECHANISM = ['checkers/lib/accname.js', 'checkers/lib/mechanism.js'];
// After Reload and record, wait this long for page scripts to start audio
// (and for Chrome's tab "audible" flag, which lags a moment) before checking.
const RECORD_SETTLE_MS = 4000;
// The Record click gives this page transient user activation (5 s in Chrome),
// and any executeScript made while it lasts carries the gesture into the
// page. Inject nothing into the reloaded page until it has expired.
const ACTIVATION_EXPIRY_MS = 6000;
let recordingAudio = false; // Reload and record in progress (side panel guards)
const LIVE_FILES = [...LIBS, 'checkers/live-regions.js'];
const LIVE_LOG_COLUMNS = ['selector', 'politeness', 'role', 'message', 'timestamp', 'url'];

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

async function inject(files, allFrames = false) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames },
    files,
  });
}

async function callChecker(name, arg = null, allFrames = false) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames },
    func: (n, a) => globalThis.__a11yCheckers[n](a),
    args: [name, arg],
  });
  return results;
}

async function hoverCall(method, index) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (m, i) => globalThis.__a11yHover[m](i),
    args: [method, index],
  });
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

async function storeToolFindings(tool, rawFindings) {
  const url = tab.url;
  const now = new Date().toISOString();
  const stamped = rawFindings.map((f) => ({ ...f, url, timestamp: now }));

  // Diff against the previous run for this URL+tool (survives restarts).
  const histKey = `history:${normUrl(url)}:${tool}`;
  const prev = (await chrome.storage.local.get(histKey))[histKey];
  const prevMap = new Map((prev?.findings || []).map((f) => [fingerprint(f), f]));
  const currentSet = new Set(stamped.map(fingerprint));
  for (const f of stamped) f.status = prevMap.has(fingerprint(f)) ? 'existing' : 'new';
  const resolved = [...prevMap.values()]
    .filter((f) => !currentSet.has(fingerprint(f)))
    .map((f) => ({ ...f, status: 'resolved', timestamp: now }));
  await chrome.storage.local.set({ [histKey]: { findings: stamped } });

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
  'text-spacing': 'badge-text-spacing',
  'focus-visibility': 'badge-focus',
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
  await chrome.storage.session.remove(findingsKey());
  for (const id of Object.values(BADGE_BY_TOOL)) $(id).hidden = true;
  renderReport({ url: tab.url, tools: {} });
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
    await inject(['checkers/lib/resolve.js', OVERLAY], true);
    // All frames: findings are collected allFrames, so the selector may live in
    // an iframe — the highlight lands wherever it matches (a generic selector
    // can match in more than one frame; scrolling inside an iframe scrolls
    // that iframe's viewport, not the top page).
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (sel, sev) => {
        const el = globalThis.__a11yResolve(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        globalThis.__a11yOverlay.outline(el, sev);
        globalThis.__a11yOverlay.badge(el, sev.charAt(0).toUpperCase(), sev);
        return true;
      },
      args: [selector, severity],
    });
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
    await inject(['checkers/lib/resolve.js', OVERLAY], true);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (list) => {
        let hit = 0;
        for (const item of list) {
          const el = globalThis.__a11yResolve(item.selector);
          if (!el) continue;
          globalThis.__a11yOverlay.outline(el, item.severity);
          globalThis.__a11yOverlay.badge(el, item.severity.charAt(0).toUpperCase(), item.severity);
          hit++;
        }
        return hit;
      },
      args: [items],
    });
    const hit = results.reduce((n, r) => n + (r.result || 0), 0);
    announce(`${tool}: highlighted ${Math.min(hit, items.length)} of ${items.length}`);
  } catch (e) {
    checkerError(e);
  }
}

// ------------------------------------------------------------ checker wiring

// Declarative checker registry: drives both the per-row Run buttons and the
// batch "Run selected" loop. Registry order IS the batch order — text-spacing
// runs after target-size/reflow (its analyze pass applies the override
// stylesheet, which would skew their measurements) and the slow hover probe
// runs last. The stateful toggles (text-spacing apply/remove, accname
// inspector, live-regions monitor) are deliberately not batchable and stay
// outside the registry, as does audio's Reload and record (it reloads the
// page, which would reset what the other checkers measure).
const CHECKERS = [
  { id: 'motion', tool: 'motion', buttonId: 'run-motion', kind: 'simple',
    files: [...MECHANISM, 'checkers/motion-check.js'], fnName: 'motion', allFrames: true,
    batchDefault: true },
  { id: 'audio', tool: 'audio', buttonId: 'run-audio', kind: 'audio',
    files: [...MECHANISM, 'checkers/audio-check.js'],
    batchDefault: true },
  { id: 'focus-visibility', tool: 'focus-visibility', buttonId: 'run-focus', kind: 'simple',
    files: [OVERLAY, 'checkers/focus-walker.js'], fnName: 'focusWalker',
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

function execEntry(entry) {
  if (entry.kind === 'hover') return execHover(entry);
  if (entry.kind === 'audio') return execAudio(entry);
  return execChecker(entry);
}

async function runFromButton(button, entry) {
  button.disabled = true;
  banner('');
  try {
    const { tool, count } = await execEntry(entry);
    announce(`${tool}: ${count} findings`);
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
      const { count } = await execEntry(entry);
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

async function refreshAccnameButton() {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!document.getElementById('__a11y-accname-tip'),
    });
    $('toggle-accname').textContent = res.result ? 'Stop inspector' : 'Start inspector';
  } catch {
    // leave default label
  }
}

async function refreshLiveRegionsButton() {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.dataset.a11yLiveMonitor === 'on',
    });
    $('toggle-live-regions').textContent = res.result ? 'Stop monitor' : 'Start monitor';
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
  // panel's restricted-UI reset and stops the panel's reload refresh from
  // injecting into the page (that injection would carry the click's gesture
  // and make page audio look user-started).
  $('record-audio').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const clickedAt = Date.now();
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
      await sleep(Math.max(RECORD_SETTLE_MS, ACTIVATION_EXPIRY_MS - (Date.now() - clickedAt)));
      const { count, hooked } = await execAudio(CHECKERS.find((c) => c.id === 'audio'));
      announce(`audio: ${count} findings after a recorded reload`);
      const problems = [];
      if (!hooked) problems.push('The recorder did not run on this page, so these are static results only (script-started audio is not covered). Try Reload and record again.');
      if (!res.loaded) problems.push('The page did not finish loading within 30 seconds. The recorded results may be incomplete.');
      if (problems.length) banner(problems.join(' '));
      // The reload reset page-side tool state; re-sync the toggle labels.
      refreshTextSpacingButton();
      refreshAccnameButton();
      refreshLiveRegionsButton();
    } catch (err) {
      checkerError(err);
    } finally {
      recordingAudio = false;
      btn.disabled = false;
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
      await inject([OVERLAY], true);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => globalThis.__a11yOverlay && globalThis.__a11yOverlay.clear(),
      });
    } catch (e) {
      checkerError(e);
    }
  });

  // Full reset: every artifact a checker leaves on the page (overlay layer,
  // text-spacing override stylesheet, live accname inspector, live-region log
  // panels), plus this tab's stored findings. Motion/reflow/hover leave
  // nothing behind.
  $('clear-all-checkers').addEventListener('click', async (e) => {
    e.target.disabled = true;
    banner('');
    try {
      await inject([OVERLAY], true);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => globalThis.__a11yOverlay && globalThis.__a11yOverlay.clear(),
      });
      await inject([...LIBS, 'checkers/text-spacing.js'], true);
      await callChecker('textSpacing', 'remove', true);
      $('toggle-text-spacing').textContent = 'Apply overrides';
      await inject([...LIBS, 'checkers/lib/accname.js', 'checkers/accname-inspector.js']);
      await callChecker('accnameInspector', 'stop');
      $('toggle-accname').textContent = 'Start inspector';
      await inject(LIVE_FILES);
      await callChecker('liveRegions', 'stop');
      $('toggle-live-regions').textContent = 'Start monitor';
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
  if (restricted) return;

  const res = await send({ type: 'getState' });
  if (token !== refreshToken) return;
  if (res && res.ok) renderState(res.state, res.caps);
  const store = await getStore();
  if (token !== refreshToken) return;
  renderReport(store);
  refreshTextSpacingButton();
  refreshAccnameButton();
  refreshLiveRegionsButton();
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'stateChanged' && tab && msg.tabId === tab.id) {
      renderState(msg.state, null);
      if (msg.reason) banner(msg.reason);
    }
  });

  if (IS_PANEL) {
    chrome.tabs.onActivated.addListener(() => refreshForActiveTab());
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      // Fires for every tab — only react to the one this panel tracks.
      // Skipped during Reload and record: the refresh would inject into the
      // reloaded page while the Record click's activation is still live.
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
    });
  }
}

init();
