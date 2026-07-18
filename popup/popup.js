// Popup: emulation controls (via the service worker / CDP), checker runner
// (direct chrome.scripting injection under activeTab), findings store with
// run-over-run diff, and CSV export.

import { downloadCsv } from './csv.js';

const LIBS = ['checkers/lib/selector.js', 'checkers/lib/findings.js'];
const OVERLAY = 'checkers/lib/overlay.js';

const $ = (id) => document.getElementById(id);
const fingerprint = (f) => `${f.tool}|${f.wcag}|${f.selector}`;

let tab = null;
let restricted = false;

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
    banner('Cannot access this page. If you navigated after opening the popup, close and reopen it to re-grant access.');
  } else {
    banner(`Checker failed: ${msg}`);
  }
}

// ------------------------------------------------------- emulation controls

function renderState(state, caps) {
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
  return stored[key] ?? { url: tab.url, tools: {} };
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
  'text-spacing': 'badge-text-spacing',
  'focus-visibility': 'badge-focus',
  'target-size': 'badge-target-size',
  'hover-content': 'badge-hover',
  reflow: 'badge-reflow',
  accname: 'badge-accname',
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

function allFindings(store) {
  const current = [];
  const resolved = [];
  for (const data of Object.values(store.tools)) {
    current.push(...data.findings);
    resolved.push(...(data.resolved || []));
  }
  return { current, resolved };
}

function renderReport(store) {
  for (const [tool, data] of Object.entries(store.tools)) {
    renderBadge(tool, data.findings);
  }
  const { current, resolved } = allFindings(store);
  if (!current.length && !resolved.length) {
    $('report-summary').textContent = 'No findings yet.';
    $('findings-list').replaceChildren();
    return;
  }
  const count = (sev) => current.filter((f) => f.severity === sev).length;
  const fresh = current.filter((f) => f.status === 'new').length;
  $('report-summary').textContent =
    `${current.length} findings — ${count('fail')} fail, ${count('warn')} warn, ` +
    `${count('review')} review. Vs last run: ${fresh} new, ${current.length - fresh} existing, ` +
    `${resolved.length} resolved.`;

  const list = $('findings-list');
  list.replaceChildren();
  for (const f of current.slice(0, 20)) {
    const li = document.createElement('li');
    li.textContent = `[${f.severity}] ${f.tool} ${f.wcag} — ${f.selector}`;
    li.title = f.details;
    list.appendChild(li);
  }
  if (current.length > 20) {
    const li = document.createElement('li');
    li.textContent = `… ${current.length - 20} more (see CSV export)`;
    list.appendChild(li);
  }
}

// ------------------------------------------------------------ checker wiring

async function runSimpleChecker(button, tool, files, fnName, { allFrames = false, arg = null } = {}) {
  button.disabled = true;
  banner('');
  try {
    await inject([...LIBS, ...files], allFrames);
    const results = await callChecker(fnName, arg, allFrames);
    const merged = results.flatMap((r) => (Array.isArray(r.result) ? r.result : []));
    const { findings } = await storeToolFindings(tool, merged);
    announce(`${tool}: ${findings.length} findings`);
  } catch (e) {
    checkerError(e);
  } finally {
    button.disabled = false;
  }
}

async function runHoverChecker(button) {
  button.disabled = true;
  banner('');
  let probing = false;
  try {
    await inject([...LIBS, 'checkers/hover-content.js']);
    const [top] = await callChecker('hoverStatic');
    const { findings, candidates } = top.result;

    if (candidates.length) {
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
    announce(`hover-content: ${stored.findings.length} findings`);
  } catch (e) {
    checkerError(e);
  } finally {
    if (probing) await send({ type: 'hoverProbe', action: 'end' }).catch(() => {});
    button.disabled = false;
  }
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

function wireCheckers() {
  $('run-motion').addEventListener('click', (e) =>
    runSimpleChecker(e.target, 'motion', ['checkers/motion-check.js'], 'motion', { allFrames: true })
  );

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

  $('run-text-spacing').addEventListener('click', async (e) => {
    await runSimpleChecker(e.target, 'text-spacing', ['checkers/text-spacing.js'], 'textSpacing', {
      allFrames: true,
      arg: 'analyze',
    });
    $('toggle-text-spacing').textContent = 'Remove overrides';
  });

  $('run-focus').addEventListener('click', (e) =>
    runSimpleChecker(e.target, 'focus-visibility', [OVERLAY, 'checkers/focus-walker.js'], 'focusWalker')
  );

  $('run-target-size').addEventListener('click', (e) =>
    runSimpleChecker(e.target, 'target-size', [OVERLAY, 'checkers/target-size.js'], 'targetSize', {
      allFrames: true,
    })
  );

  $('run-hover').addEventListener('click', (e) => runHoverChecker(e.target));

  $('run-reflow-scan').addEventListener('click', (e) =>
    runSimpleChecker(e.target, 'reflow', ['checkers/reflow-scan.js'], 'reflowScan')
  );

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
}

// -------------------------------------------------------------- report wiring

function wireReport() {
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
    downloadCsv(rows, `a11y-findings-${host}-${stamp}.csv`);
  });

  $('clear-findings').addEventListener('click', async () => {
    await chrome.storage.session.remove(findingsKey());
    for (const id of Object.values(BADGE_BY_TOOL)) $(id).hidden = true;
    renderReport({ url: tab.url, tools: {} });
  });

  $('clear-history').addEventListener('click', async () => {
    const prefix = `history:${normUrl(tab.url)}:`;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
    if (keys.length) await chrome.storage.local.remove(keys);
    announce(`Cleared ${keys.length} stored run(s) for this URL.`);
  });
}

// ----------------------------------------------------------------------- init

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  restricted = isRestricted(tab && tab.url);

  if (restricted) {
    $('restricted-msg').hidden = false;
    for (const el of document.querySelectorAll('input, button')) el.disabled = true;
    return;
  }

  try {
    wireEmulation();
    wireCheckers();
    wireReport();
  } catch (e) {
    // A wiring failure (e.g. stale cached popup.js against a newer
    // popup.html) would otherwise leave every button dead with no clue.
    banner(`Popup failed to initialize: ${e.message}. Reload the extension at chrome://extensions and reopen.`);
    throw e;
  }

  const res = await send({ type: 'getState' });
  if (res && res.ok) renderState(res.state, res.caps);

  renderReport(await getStore());
  refreshTextSpacingButton();
  refreshAccnameButton();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'stateChanged' && msg.tabId === tab.id) {
      renderState(msg.state, null);
      if (msg.reason) banner(msg.reason);
    }
  });
}

init();
