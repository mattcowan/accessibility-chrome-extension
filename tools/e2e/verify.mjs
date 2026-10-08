// End-to-end verify for the extension: loads it into a real Chromium with
// Playwright, drives the real popup buttons and the real chrome.runtime
// message protocol from an extension page, and asserts checker findings
// against the data-expect attributes in test-pages/.
//
// Run from the repo root (needs the scanner's Playwright install first:
// `cd tools/keyboard-trap-scan && npm ci`):
//   node tools/e2e/verify.mjs
// Prints PASS/FAIL per check and "N/M passed"; exits 1 on any failure.
//
// Coverage today: motion 2.2.2 / TT 2.B mechanisms, the audio checker
// (1.4.2 / TT 2.A) under allowed and blocked autoplay, Reload and record
// (popup and side-panel contexts), the batch runner, the recorder
// handshake, the keyboard access scan (2.1.1 / TT 4.A), the focus locator
// (real Tab / Shift+Tab presses), and the Trusted Tester section 5 tools: form
// labels (5.C), error capture (5.F / 5.G) and the input watcher (5.D / 5.E),
// where the test plays the tester with real clicks, keys and selects. Older checkers (text spacing, target size, focus, hover, reflow,
// accname, live regions) are not covered yet; add a section per checker.
//
// How it works (see CLAUDE.md "Verify changes" for the gotchas):
// - The extension is staged to a temp folder with host_permissions added, so
//   chrome.scripting works without an activeTab click.
// - test-pages/ is served over a local HTTP server (extensions cannot inject
//   into file:// pages).
// - Autoplay behavior is set per browser launch with --autoplay-policy.
// - Page state is probed from the service worker when user activation
//   matters: Playwright's page.evaluate and popup-driven injections both
//   carry a user gesture into the page.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO, 'tools', 'keyboard-trap-scan', 'x.js'));
const { chromium } = require('playwright');

// ---- stage the extension with host_permissions (no activeTab gesture in E2E)
const STAGE = path.join(os.tmpdir(), 'a11y-modes-e2e-stage');
fs.rmSync(STAGE, { recursive: true, force: true });
for (const dir of ['background', 'checkers', 'popup', 'icons']) {
  fs.cpSync(path.join(REPO, dir), path.join(STAGE, dir), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---- serve test-pages over http (extensions can't inject into file://)
const server = http.createServer((req, res) => {
  const p = path.join(REPO, 'test-pages', decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(path.join(REPO, 'test-pages')) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, info = '') {
  (ok ? pass++ : fail++);
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${info}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(policy, { panel = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-e2e-'));
  // Throwaway profile: delete it when the browser closes.
  const removeProfile = () => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows can still hold a file lock for a moment; the OS temp cleanup gets it.
    }
  };
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${STAGE}`,
      `--load-extension=${STAGE}`,
      `--autoplay-policy=${policy}`,
    ],
  });
  ctx.on('close', removeProfile);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html${panel ? '?context=panel' : ''}`);
  return { ctx, popup, id };
}

// Open fixture as the active tab and point the (background-tab) popup at it.
async function openFixture(env, file, waitMs = 2500) {
  const page = await env.ctx.newPage();
  await page.goto(BASE + file);
  await page.bringToFront();
  await sleep(waitMs);
  await env.popup.reload();
  await env.popup.waitForFunction(() => document.getElementById('report-summary'));
  await sleep(300);
  const tabId = await env.popup.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t.id;
  });
  return { page, tabId };
}

// Selector + expectation for each [data-expect] element, computed in the
// isolated world with the extension's own selector.js.
async function expectations(env, tabId, attr) {
  return env.popup.evaluate(
    async ({ tabId, attr }) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['checkers/lib/selector.js'] });
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (a) =>
          [...document.querySelectorAll('[data-expect]')].map((el) => ({
            id: el.id || el.tagName.toLowerCase(),
            tag: el.tagName.toLowerCase(),
            sel: el === document.body ? '(page)' : globalThis.__a11ySelector(el),
            expect:
              (a && el.getAttribute(a)) ||
              (a === 'data-expect-recorded' && el.getAttribute('data-expect-blocked')) ||
              el.getAttribute('data-expect'),
          })),
        args: [attr],
      });
      return r.result;
    },
    { tabId, attr: attr || null }
  );
}

async function clickAndWait(env, buttonId, doneRe, timeout = 60000) {
  await env.popup.evaluate(() => (document.getElementById('status').textContent = ''));
  await env.popup.click(`#${buttonId}`);
  await env.popup.waitForFunction(
    (re) => new RegExp(re).test(document.getElementById('status').textContent),
    doneRe.source,
    { timeout }
  );
}

async function storedFindings(env, tabId, tool) {
  return env.popup.evaluate(
    async ({ tabId, tool }) => {
      const key = `findings:${tabId}`;
      const store = (await chrome.storage.session.get(key))[key];
      return (store && store.tools[tool] && store.tools[tool].findings) || [];
    },
    { tabId, tool }
  );
}

const RANK = { fail: 3, warn: 2, review: 1 };
function severityFor(findings, sel, wcag) {
  let best = 'pass';
  for (const f of findings) {
    if (f.selector !== sel || (wcag && f.wcag !== wcag)) continue;
    if (best === 'pass' || RANK[f.severity] > RANK[best]) best = f.severity;
  }
  return best;
}

async function assertPage(env, label, file, { tool, buttonId, attr, wcag, only, waitMs, recorded }) {
  const { page, tabId } = await openFixture(env, file, waitMs);
  await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
  if (recorded) await clickAndWait(env, 'record-audio', /after a recorded reload/);
  else await clickAndWait(env, buttonId, new RegExp(`^${tool}: \\d+ findings`));
  const findings = await storedFindings(env, tabId, tool);
  let exps = await expectations(env, tabId, attr);
  if (only) exps = exps.filter(only);
  for (const e of exps) {
    const got = severityFor(findings, e.sel, wcag);
    check(`${label} ${file} #${e.id} → ${e.expect}`, got === e.expect, `got ${got}; findings: ${JSON.stringify(findings.map((f) => [f.severity, f.selector, f.details.slice(0, 90)]))}`);
  }
  await page.close();
  return findings;
}

try {
  // ======================= autoplay ALLOWED =======================
  let env = await launch('no-user-gesture-required');

  // #3 — motion 2.B mechanisms (videos only; other motion.html cases depend on RM emulation).
  for (const file of ['motion.html', 'video-pause-controls.html', 'video-pause-all.html']) {
    await assertPage(env, '[motion]', file, {
      tool: 'motion', buttonId: 'run-motion', wcag: '2.2.2', only: (e) => e.tag === 'video', waitMs: 800,
    });
  }
  // <audio> no longer reported by the motion checker.
  {
    const { page, tabId } = await openFixture(env, 'audio-autoplay.html');
    await clickAndWait(env, 'run-motion', /^motion: \d+ findings/);
    const f = await storedFindings(env, tabId, 'motion');
    check('[motion] audio-autoplay.html has no 2.2.2 finding for <audio>', !f.some((x) => x.wcag === '2.2.2' && /audio/.test(x.snippet)), JSON.stringify(f));
    await page.close();
  }

  // #10 — audio, playing case.
  // 5 s wait: #over (3.5 s clip) must have ended, so its plain-Run grade is stable.
  await assertPage(env, '[audio allowed]', 'audio-autoplay.html', { tool: 'audio', buttonId: 'run-audio', wcag: '1.4.2', waitMs: 5000 });
  await assertPage(env, '[audio allowed]', 'audio-pause-first.html', { tool: 'audio', buttonId: 'run-audio', wcag: '1.4.2' });
  await assertPage(env, '[audio allowed]', 'audio-script.html', { tool: 'audio', buttonId: 'run-audio', wcag: '1.4.2' });

  // Batch includes audio.
  {
    const { page, tabId } = await openFixture(env, 'audio-pause-first.html');
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await env.popup.evaluate(() => {
      for (const b of document.querySelectorAll('.batch-select')) b.checked = b.dataset.batchId === 'audio' || b.dataset.batchId === 'motion';
    });
    await clickAndWait(env, 'run-selected', /^Batch complete/);
    const f = await storedFindings(env, tabId, 'audio');
    check('[batch] Run selected runs the audio checker', f.length >= 1, JSON.stringify(f));
    await page.close();
  }
  // Reload and record with autoplay allowed: the hook proves the script
  // started #scripted with no user action, so it is a definite fail.
  {
    const { page, tabId } = await openFixture(env, 'audio-autoplay.html', 500);
    await clickAndWait(env, 'record-audio', /after a recorded reload/);
    const f = await storedFindings(env, tabId, 'audio');
    for (const id of ['#scripted', '#delayed', '#over']) {
      const got = severityFor(f, id, '1.4.2');
      check(`[audio allowed recorded] audio-autoplay.html ${id} → fail`, got === 'fail', `got ${got}: ${JSON.stringify(f.map((x) => [x.severity, x.selector]))}`);
    }
    const banner = await env.popup.evaluate(() => document.getElementById('banner').textContent);
    check('[audio allowed recorded] no "recorder did not run" banner', !/recorder did not run/i.test(banner), banner);
    await page.close();
  }
  // Plain Run after a 3.5 s autoplay clip has ended: still reported (never
  // silently missed), capped at review without a recording (PR #16 review).
  {
    const { page, tabId } = await openFixture(env, 'audio-autoplay.html', 6000);
    await clickAndWait(env, 'run-audio', /^audio: \d+ findings/);
    const f = await storedFindings(env, tabId, 'audio');
    const got = severityFor(f, '#over', '1.4.2');
    check('[audio allowed late] ended 3.5 s autoplay #over → review (no recording)', got === 'review', `got ${got}`);
    await page.close();
  }
  // Without Reload and record, the checker must report that no hook ran.
  {
    const { page, tabId } = await openFixture(env, 'audio-pause-first.html', 500);
    const hooked = await env.popup.evaluate(async (tabId) => {
      for (const file of ['checkers/lib/selector.js', 'checkers/lib/findings.js', 'checkers/lib/accname.js', 'checkers/lib/mechanism.js', 'checkers/audio-check.js']) {
        await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      }
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__a11yCheckers.audio().hooked });
      return r.result;
    }, tabId);
    check('[handshake] plain page reports hooked: false', hooked === false, String(hooked));
    await page.close();
  }
  await env.ctx.close();

  // ======================= autoplay BLOCKED =======================
  env = await launch('document-user-activation-required');
  for (const file of ['audio-autoplay.html', 'audio-pause-first.html', 'audio-script.html']) {
    await assertPage(env, '[audio blocked]', file, { tool: 'audio', buttonId: 'run-audio', attr: 'data-expect-blocked', wcag: '1.4.2' });
  }
  for (const file of ['audio-autoplay.html', 'audio-script.html']) {
    await assertPage(env, '[audio recorded]', file, { tool: 'audio', attr: 'data-expect-recorded', wcag: '1.4.2', recorded: true });
  }
  // Review item 4: play() blocked on load, then the USER starts it from the
  // native controls (a real click; no JS play()). Must not report as autoplay.
  {
    const { page, tabId } = await openFixture(env, 'audio-autoplay.html', 500);
    await clickAndWait(env, 'record-audio', /after a recorded reload/);
    const [sw] = env.ctx.serviceWorkers();
    // Gesture-free (SW) injection: give #scripted native controls.
    await sw.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const el = document.getElementById('scripted');
          el.controls = true;
          el.scrollIntoView({ block: 'center' });
        },
      });
    }, tabId);
    await page.bringToFront();
    await sleep(300);
    const box = await page.locator('#scripted').boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2); // native play button
    await sleep(1500);
    const playingNow = await sw.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !document.getElementById('scripted').paused });
      return r.result;
    }, tabId);
    check('[item 4] native-controls click started #scripted', playingNow, 'still paused — click missed the play button');
    await env.popup.reload();
    await sleep(500);
    await clickAndWait(env, 'run-audio', /^audio: \d+ findings/);
    const f = await storedFindings(env, tabId, 'audio');
    const got = severityFor(f, '#scripted', '1.4.2');
    check('[item 4] user-started #scripted after blocked play() → pass', got === 'pass', `got ${got}: ${JSON.stringify(f.filter((x) => x.selector === '#scripted').map((x) => x.details.slice(0, 80)))}`);
    await page.close();
  }
  // PR #16 review item 3: a second recordAudio on the same tab is refused.
  {
    const { page, tabId } = await openFixture(env, 'audio-script.html', 500);
    const [a, b] = await env.popup.evaluate(
      (tabId) =>
        Promise.all([
          chrome.runtime.sendMessage({ type: 'recordAudio', tabId }),
          chrome.runtime.sendMessage({ type: 'recordAudio', tabId }),
        ]),
      tabId
    );
    const oks = [a, b].filter((r) => r && r.ok).length;
    const refused = [a, b].find((r) => r && !r.ok);
    check('[concurrent] exactly one recordAudio runs', oks === 1, JSON.stringify([a, b]));
    check('[concurrent] the other is refused as already running', !!refused && /already running/.test(refused.error), JSON.stringify(refused));
    await page.close();
  }
  // Reload and record must leave the debugger detached when no emulation is on.
  {
    const { page, tabId } = await openFixture(env, 'audio-script.html', 500);
    await clickAndWait(env, 'record-audio', /after a recorded reload/);
    // Playwright's own CDP session makes getTargets() report attached:true, so
    // check the extension's stored state (detachIfIdle clears it on detach).
    const state = await env.popup.evaluate(
      async (tabId) => (await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || null,
      tabId
    );
    check('[recorded] extension detached after Reload and record', !state || !state.attached, JSON.stringify(state));
    // A later reload is not hooked (script removed).
    await page.reload();
    await sleep(1000);
    const hooked = await page.evaluate(() => !!window.__a11yAudioHook);
    check('[recorded] hook not installed on the next reload', !hooked, 'hook present after plain reload');
    await page.close();
  }
  await env.ctx.close();

  // ============ autoplay BLOCKED, SIDE PANEL context (review item 2) ============
  env = await launch('document-user-activation-required', { panel: true });
  {
    const { page, tabId } = await openFixture(env, 'audio-autoplay.html', 500);
    // Watch for the record button re-enabling before the cycle finishes.
    await env.popup.evaluate(() => {
      window.__enabledEarly = false;
      const b = document.getElementById('record-audio');
      new MutationObserver(() => {
        const done = /after a recorded reload/.test(document.getElementById('status').textContent);
        if (!b.disabled && !done) window.__enabledEarly = true;
      }).observe(b, { attributes: true, attributeFilter: ['disabled'] });
    });
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await clickAndWait(env, 'record-audio', /after a recorded reload/);
    const early = await env.popup.evaluate(() => window.__enabledEarly);
    check('[panel recorded] record button stays disabled for the whole cycle', !early, 'button re-enabled mid-cycle');
    const f = await storedFindings(env, tabId, 'audio');
    const exps = await expectations(env, tabId, 'data-expect-recorded');
    for (const e of exps) {
      const got = severityFor(f, e.sel, '1.4.2');
      check(`[panel recorded] audio-autoplay.html #${e.id} → ${e.expect}`, got === e.expect, `got ${got}`);
    }
    await page.close();
  }
  await env.ctx.close();

  // ============ #20: keyboard access scan (2.1.1 / TT 4.A) + focus locator ============
  env = await launch('no-user-gesture-required');
  {
    const { page, tabId } = await openFixture(env, 'keyboard-access.html', 800);
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await clickAndWait(env, 'run-keyboard-access', /^keyboard-access: \d+ findings/);
    const f = await storedFindings(env, tabId, 'keyboard-access');
    for (const e of await expectations(env, tabId)) {
      const got = severityFor(f, e.sel, '2.1.1');
      check(`[keyboard-access] keyboard-access.html #${e.id} → ${e.expect}`, got === e.expect, `got ${got}; findings: ${JSON.stringify(f.map((x) => [x.severity, x.selector, x.details.slice(0, 90)]))}`);
    }
    const shadow = severityFor(f, '#shadow-host >>> #shadow-span', '2.1.1');
    check('[keyboard-access] span role=button in an open shadow root → review', shadow === 'review', `got ${shadow}`);
    const inertShadow = severityFor(f, '#inert-host >>> #inert-span', '2.1.1');
    check('[keyboard-access] span role=button in a shadow root under an inert host → pass', inertShadow === 'pass', `got ${inertShadow}`);
    check('[keyboard-access] every finding is 2.1.1 review', f.length > 0 && f.every((x) => x.wcag === '2.1.1' && x.severity === 'review'), JSON.stringify(f.map((x) => [x.wcag, x.severity])));
    const listenerDiv = f.find((x) => x.selector === '#listener-div');
    check('[keyboard-access] #listener-div found through its CDP click listener', !!listenerDiv && /a click listener/.test(listenerDiv.details), JSON.stringify(listenerDiv));
    check('[keyboard-access] no "(page)" note: click listeners were read', !f.some((x) => x.selector === '(page)'), JSON.stringify(f.filter((x) => x.selector === '(page)')));
    const state = await env.popup.evaluate(
      async (tabId) => (await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || null,
      tabId
    );
    check('[keyboard-access] extension detached after reading listeners', !state || !state.attached, JSON.stringify(state));

    // Debugger holds: a listener read during a hover probe must not detach
    // the probe's session; the probe's 'end' detaches.
    const held = await env.popup.evaluate(async (tabId) => {
      const tabState = async () => ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || {}).attached === true;
      const start = await chrome.runtime.sendMessage({ type: 'hoverProbe', action: 'start', tabId });
      const read = await chrome.runtime.sendMessage({ type: 'clickListeners', tabId });
      const duringProbe = await tabState();
      await chrome.runtime.sendMessage({ type: 'hoverProbe', action: 'end', tabId });
      return { start: start.ok, read: read.ok, duringProbe, afterEnd: await tabState() };
    }, tabId);
    check('[keyboard-access] listener read keeps a running hover probe attached', held.start && held.read && held.duringProbe, JSON.stringify(held));
    check('[keyboard-access] hover probe end then detaches', !held.afterEnd, JSON.stringify(held));

    // Turning the last emulation toggle off during a hold must not detach.
    const toggled = await env.popup.evaluate(async (tabId) => {
      const tabState = async () => ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || {}).attached === true;
      const send = (m) => chrome.runtime.sendMessage({ ...m, tabId });
      await send({ type: 'hoverProbe', action: 'start' });
      await send({ type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: 'reduce' });
      const off = await send({ type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: null });
      const duringHold = await tabState();
      await send({ type: 'hoverProbe', action: 'end' });
      return { offOk: off.ok, duringHold, afterEnd: await tabState() };
    }, tabId);
    check('[holds] last emulation toggle off during a hover probe keeps it attached', toggled.offOk && toggled.duringHold, JSON.stringify(toggled));
    check('[holds] hover probe end then detaches (emulation all off)', !toggled.afterEnd, JSON.stringify(toggled));

    // An orphaned hover hold (popup closed before 'end') lapses after 15 s
    // with no hover message, so turning emulation off then detaches.
    const orphan = await env.popup.evaluate(async (tabId) => {
      const tabState = async () => ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || {}).attached === true;
      const send = (m) => chrome.runtime.sendMessage({ ...m, tabId });
      await send({ type: 'hoverProbe', action: 'start' }); // never ended
      await send({ type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: 'reduce' });
      await new Promise((r) => setTimeout(r, 16000));
      await send({ type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: null });
      const afterOff = await tabState();
      // The lapsed hold must not survive into the next probe: a second probe
      // run to 'end' (emulation off) detaches.
      await send({ type: 'hoverProbe', action: 'start' });
      const duringSecond = await tabState();
      await send({ type: 'hoverProbe', action: 'end' });
      return { afterOff, duringSecond, afterSecondEnd: await tabState() };
    }, tabId);
    check('[holds] orphaned hover hold lapses; emulation off then detaches', !orphan.afterOff, JSON.stringify(orphan));
    check('[holds] a probe after a lapsed one detaches at its end', orphan.duringSecond && !orphan.afterSecondEnd, JSON.stringify(orphan));

    // The outline:none button is a 2.4.7 problem for Focus visibility, not 2.1.1.
    await clickAndWait(env, 'run-focus', /^focus-visibility: \d+ findings/);
    const fv = await storedFindings(env, tabId, 'focus-visibility');
    const got = severityFor(fv, '#no-outline', '2.4.7');
    check('[focus-visibility] keyboard-access.html #no-outline → 2.4.7 fail', got === 'fail', `got ${got}`);

    // Batch runs the scan.
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await env.popup.evaluate(() => {
      for (const b of document.querySelectorAll('.batch-select')) b.checked = b.dataset.batchId === 'keyboard-access';
    });
    await clickAndWait(env, 'run-selected', /^Batch complete/);
    const bf = await storedFindings(env, tabId, 'keyboard-access');
    check('[batch] Run selected runs the keyboard access scan', bf.some((x) => x.selector === '#click-div'), JSON.stringify(bf.map((x) => x.selector)));
    await page.close();
  }

  // Focus locator: real Tab / Shift+Tab presses; the locator must follow
  // focus into the shadow root and the same-origin iframe, and grade the
  // page's own indicator per data-expect-focus.
  {
    const { page, tabId } = await openFixture(env, 'keyboard-access.html', 800);
    // The element the page really focused, as the locator's selector would
    // name it (selector.js is id-first; every tab stop has an id).
    const realFocus = () =>
      page.evaluate(() => {
        let doc = document;
        for (;;) {
          let a = doc.activeElement;
          const chain = [];
          while (a && a.shadowRoot && a.shadowRoot.activeElement) {
            chain.push(a);
            a = a.shadowRoot.activeElement;
          }
          if (a && a.tagName === 'IFRAME' && a.contentDocument) {
            doc = a.contentDocument;
            continue;
          }
          const leaf = a;
          return {
            sel: [...chain, leaf].map((e) => `#${e.id}`).join(' >>> '),
            expect: leaf.getAttribute('data-expect-focus'),
          };
        }
      });
    const locator = () =>
      page.evaluate(() => {
        const l = document.getElementById('__a11y-focus-locator');
        if (!l) return null;
        const r = l.firstChild.getBoundingClientRect();
        return { ...l.dataset, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
      });
    const pageRect = (sel) =>
      page.evaluate((sel) => {
        if (sel === '#frame-btn') {
          const fr = document.getElementById('frame');
          const o = fr.getBoundingClientRect();
          const r = fr.contentDocument.getElementById('frame-btn').getBoundingClientRect();
          return { x: o.x + fr.clientLeft + r.x, y: o.y + fr.clientTop + r.y };
        }
        const r = document.getElementById('shadow-host').shadowRoot.getElementById('shadow-btn').getBoundingClientRect();
        return { x: r.x, y: r.y };
      }, sel);

    await page.keyboard.press('Tab'); // #offscreen, before the locator starts
    await sleep(200);
    const before = await realFocus();
    await env.popup.evaluate(() => (document.getElementById('status').textContent = ''));
    await env.popup.click('#toggle-focus-locator');
    await env.popup.waitForFunction(() => /focus locator: on/.test(document.getElementById('status').textContent));
    await sleep(400);
    const after = await realFocus();
    check('[locator] starting it does not move focus', before.sel === after.sel && after.sel === '#offscreen', `${before.sel} → ${after.sel}`);
    let loc = await locator();
    check('[locator] off-screen skip link → hidden (4.D, not 4.A)', loc && loc.target === '#offscreen' && loc.verdict === 'hidden', JSON.stringify(loc));
    // The fixture has `::backdrop { background: rgba(0,0,0,.5) }`; the
    // locator's top-layer box must not take it and dim the page.
    const backdrop = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('__a11y-focus-locator'), '::backdrop');
      return { display: cs.display, background: cs.backgroundColor };
    });
    check('[locator] page ::backdrop rule does not dim the page', backdrop.display === 'none' || backdrop.background === 'rgba(0, 0, 0, 0)', JSON.stringify(backdrop));

    // Every element with a locator expectation, so a fixture change that
    // drops one from the Tab walk fails instead of skipping its check.
    const expectFocus = await page.evaluate(() => [...document.querySelectorAll('[data-expect-focus]')].map((e) => `#${e.id}`));
    const visited = ['#offscreen'];
    const step = async (key) => {
      await page.keyboard.press(key);
      await sleep(300);
      const real = await realFocus();
      loc = await locator();
      visited.push(real.sel);
      check(`[locator] ${key} → ${real.sel} tracked`, !!loc && loc.target === real.sel, `locator ${JSON.stringify(loc)}`);
      if (real.expect) {
        check(`[locator] ${real.sel} verdict → ${real.expect}`, loc && loc.verdict === real.expect, `got ${loc && loc.verdict}`);
      }
      if (real.sel === '#frame-btn' || real.sel === '#shadow-host >>> #shadow-btn') {
        const r = await pageRect(real.sel);
        // Box = element rect grown by GAP (4) + border (3) on each side.
        const ok = Math.abs(loc.box.x + 7 - r.x) < 2 && Math.abs(loc.box.y + 7 - r.y) < 2;
        check(`[locator] box drawn on ${real.sel}`, ok, `box ${JSON.stringify(loc.box)} vs element ${JSON.stringify(r)}`);
      }
    };
    for (let i = 0; i < 11; i++) await step('Tab');
    for (let i = 0; i < 3; i++) await step('Shift+Tab');
    check('[locator] walk reached the shadow-root and iframe buttons', visited.includes('#shadow-host >>> #shadow-btn') && visited.includes('#frame-btn'), JSON.stringify(visited));
    const missed = expectFocus.filter((sel) => !visited.includes(sel));
    check(`[locator] walk visited all ${expectFocus.length} data-expect-focus elements`, expectFocus.length >= 5 && !missed.length, `missed ${JSON.stringify(missed)}`);
    // A button added after the start gets its baseline when it is inserted,
    // so its first verdict is a real one ('none'), not 'unknown'.
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'late-btn';
      b.type = 'button';
      b.textContent = 'Added later';
      b.style.outline = 'none';
      b.setAttribute('data-expect-focus', 'none');
      document.getElementById('agree').after(b);
    });
    await sleep(200);
    await step('Tab');
    check('[locator] Tab reached the button added after the start', visited[visited.length - 1] === '#late-btn', JSON.stringify(visited.slice(-1)));

    // The popup re-syncs its button label from the page marker.
    await env.popup.reload();
    await env.popup.waitForFunction(() => document.getElementById('toggle-focus-locator').textContent === 'Stop locator', null, { timeout: 5000 }).catch(() => {});
    const label = await env.popup.evaluate(() => document.getElementById('toggle-focus-locator').textContent);
    check('[locator] reopened popup shows "Stop locator"', label === 'Stop locator', label);

    // Turning it off removes everything it added, and it stays gone on Tab.
    // The label is made stale first ("Start" while the locator runs, as when
    // the side panel stopped and restarted it): the toggle must ask the page.
    await env.popup.evaluate(() => {
      document.getElementById('status').textContent = '';
      document.getElementById('toggle-focus-locator').textContent = 'Start locator';
    });
    await env.popup.click('#toggle-focus-locator');
    await env.popup.waitForFunction(() => /focus locator: off/.test(document.getElementById('status').textContent));
    await page.keyboard.press('Tab');
    await sleep(300);
    const leftovers = await page.evaluate(() => ({
      layer: !!document.getElementById('__a11y-focus-locator'),
      marker: document.documentElement.hasAttribute('data-a11y-focus-locator'),
      ids: [...document.querySelectorAll('[id^="__a11y"]')].map((e) => e.id),
    }));
    check('[locator] stop removes the layer and the marker', !leftovers.layer && !leftovers.marker, JSON.stringify(leftovers));

    // Clear all checkers also stops it.
    await env.popup.click('#toggle-focus-locator');
    await env.popup.waitForFunction(() => /focus locator: on/.test(document.getElementById('status').textContent));
    await clickAndWait(env, 'clear-all-checkers', /^Cleared/);
    await sleep(200);
    const cleared = await page.evaluate(() => !document.getElementById('__a11y-focus-locator') && !document.documentElement.hasAttribute('data-a11y-focus-locator'));
    const label2 = await env.popup.evaluate(() => document.getElementById('toggle-focus-locator').textContent);
    check('[locator] Clear all checkers stops the locator', cleared && label2 === 'Start locator', `${cleared} ${label2}`);
    await page.close();
  }
  await env.ctx.close();

  // ============ #24: form labels (1.3.1 / TT 5.C) ============
  env = await launch('no-user-gesture-required');
  {
    const f = await assertPage(env, '[form-labels]', 'form-labels.html', {
      tool: 'form-labels', buttonId: 'run-form-labels', wcag: '1.3.1', waitMs: 500,
    });
    const det = (sel) => (f.find((x) => x.selector === sel) || {}).details || '';
    const qty = det('#qty-a');
    check('[form-labels] repeated "Quantity": row and column headers listed for each field', /"Widget A"/.test(qty) && /"Widget B"/.test(qty) && /column header "Quantity"/.test(qty) && !/Nothing tells/.test(qty), qty);
    check('[form-labels] table with no th: the finding says nothing tells the fields apart', /Nothing tells/.test(det('#qty-plain-a')), det('#qty-plain-a'));
    check('[form-labels] group with aria-describedby quotes the description', /Do you want the newsletter/.test(det('#newsletter-yes')), det('#newsletter-yes'));
    check('[form-labels] bulk-select checkboxes with row headers: review, headers named', /Every member is in a table cell with headers/.test(det('#order-1001')), det('#order-1001'));
    check('[form-labels] aria-labelledby that joins the question: review, name quoted', /joins more than one element \("How do you want to pay\? Card"\)/.test(det('#pay-card')), det('#pay-card'));
    check('[form-labels] every finding is 1.3.1', f.length > 0 && f.every((x) => x.wcag === '1.3.1'), JSON.stringify(f.map((x) => x.wcag)));
  }
  {
    const { page, tabId } = await openFixture(env, 'form-labels.html', 500);
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await env.popup.evaluate(() => {
      for (const b of document.querySelectorAll('.batch-select')) b.checked = b.dataset.batchId === 'form-labels';
    });
    await clickAndWait(env, 'run-selected', /^Batch complete/);
    const bf = await storedFindings(env, tabId, 'form-labels');
    check('[batch] Run selected runs the form labels checker', severityFor(bf, '#contact-email', '1.3.1') === 'fail', JSON.stringify(bf.map((x) => [x.severity, x.selector])));
    await page.close();
  }

  // ============ #22: error capture (3.3.1 / TT 5.F, 5.G) ============
  // The test plays the tester: it clicks each Submit button with the fields
  // empty. The capture only watches.
  {
    const { page, tabId } = await openFixture(env, 'form-errors.html', 500);
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    // (h)'s valid field has focus at Start, so its first baseline is its
    // focus style (the capture replaces it when the field loses focus).
    await page.focus('#h-company');
    await clickAndWait(env, 'toggle-error-capture', /^error capture: on/);
    const captures = () => page.evaluate(() => Number(document.documentElement.dataset.a11yErrorCaptures || 0));
    const enterIn = (sel) => async () => {
      await page.click(sel);
      await page.keyboard.press('Enter');
    };
    const steps = [
      ...['submit-a', 'submit-b', 'submit-c', 'submit-d', 'submit-e', 'submit-f'].map((id) => [id, () => page.click(`#${id}`)]),
      ['Enter in #g-code', enterIn('#g-code')],
      ['Enter in #h-company', enterIn('#h-company')],
    ];
    for (const [id, act] of steps) {
      const before = await captures();
      await act();
      const done = await page
        .waitForFunction((n) => Number(document.documentElement.dataset.a11yErrorCaptures || 0) > n, before, { timeout: 8000 })
        .then(() => true, () => false);
      check(`[error-capture] a capture window closed after #${id}`, done, `captures still ${before}`);
    }
    await sleep(500);
    // Pushed by the page to the open popup (errorCaptureUpdate), no popup click.
    const f = await storedFindings(env, tabId, 'error-capture');
    for (const e of await expectations(env, tabId)) {
      const got = severityFor(f, e.sel, '3.3.1');
      check(`[error-capture] form-errors.html #${e.id} → ${e.expect}`, got === e.expect, `got ${got}; findings: ${JSON.stringify(f.map((x) => [x.severity, x.selector, x.details.slice(0, 120)]))}`);
    }
    const det = (sel) => (f.find((x) => x.selector === sel) || {}).details || '';
    check('[error-capture] (a) quotes the error text and names aria-describedby and aria-invalid', /"Enter your email address, for example name@example.com\." \(tied by aria-describedby\)/.test(det('#a-email')) && /Cues found:[^.]*aria-invalid="true"/.test(det('#a-email')), det('#a-email'));
    check('[error-capture] (a) names the missing announcement', /Cues missing:[^]*an announcement/.test(det('#a-email')), det('#a-email'));
    check('[error-capture] (b) text near the field is "not tied", and the tie is a missing cue', /"Enter your first name\." \(near the field, not tied\)/.test(det('#b-first')) && /Cues missing: [^]*text tied to the field/.test(det('#b-first')), det('#b-first'));
    check('[error-capture] (c) color only: says no error text was found', /No error text was found/.test(det('#c-city')) && /border color/.test(det('#c-city')), det('#c-city'));
    check('[error-capture] (d) type="button" script form: role="alert" announcement found', /Announced: "Phone number is required\." \(role="alert"\)/.test(det('#d-phone')), det('#d-phone'));
    check('[error-capture] (e) error summary link and the focus move to it', /"Enter your full name" \(in an error summary link\)/.test(det('#e-name')) && /Focus moved to #e-summary/.test(det('#e-name')), det('#e-name'));
    check('[error-capture] (f) browser validation (invalid event) recorded', /Browser validation message: "/.test(det('#f-zip')) && /Focus moved to the field/.test(det('#f-zip')), det('#f-zip'));
    const g = det('#g-code');
    check('[error-capture] (g) Enter in the field: focus that stays is not a focus move', /"Enter the promo code from your email."/.test(g) && !/Focus moved/.test(g) && /Cues missing:[^]*an announcement/.test(g), g);
    check('[error-capture] (g) a focus style is not counted as an error color', !/a color change/.test(g), g);
    // Eight capture windows each pushed an incremental store; a fresh profile
    // has no history, so every finding must still be "new".
    check('[error-capture] incremental updates keep every finding "new"', f.length > 0 && f.every((x) => x.status === 'new'), JSON.stringify(f.map((x) => [x.selector, x.status])));
    check('[error-capture] every finding is 3.3.1', f.length > 0 && f.every((x) => x.wcag === '3.3.1'), JSON.stringify(f.map((x) => x.wcag)));

    // The popup re-syncs its label from the page.
    await env.popup.reload();
    await env.popup.waitForFunction(() => document.getElementById('toggle-error-capture').textContent === 'Stop capture', null, { timeout: 5000 }).catch(() => {});
    check('[error-capture] reopened popup shows "Stop capture"', (await env.popup.evaluate(() => document.getElementById('toggle-error-capture').textContent)) === 'Stop capture');

    // Stop removes everything the capture added; the findings stay.
    await clickAndWait(env, 'toggle-error-capture', /^error capture: off/);
    const leftovers = await page.evaluate(() => [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-a11y')));
    check('[error-capture] Stop removes the page markers', !leftovers.length, JSON.stringify(leftovers));
    check('[error-capture] findings stay after Stop', (await storedFindings(env, tabId, 'error-capture')).length === f.length);

    // Clear all checkers also stops it.
    await clickAndWait(env, 'toggle-error-capture', /^error capture: on/);
    await clickAndWait(env, 'clear-all-checkers', /^Cleared/);
    const cleared = await page.evaluate(() => !document.documentElement.hasAttribute('data-a11y-error-capture'));
    const label = await env.popup.evaluate(() => document.getElementById('toggle-error-capture').textContent);
    check('[error-capture] Clear all checkers stops the capture', cleared && label === 'Start capture', `${cleared} ${label}`);
    await page.close();
  }

  // ============ #23: input watcher (3.2.2 / 4.1.2, TT 5.D / 5.E) ============
  // The test plays the tester (real clicks, keys and selects); the watcher
  // only watches. The select in (a) navigates last, and the findings are then
  // read from the SW-kept log by a freshly loaded popup.
  {
    const { page, tabId } = await openFixture(env, 'form-input.html', 500);
    await env.popup.evaluate(async (k) => chrome.storage.session.remove(k), `findings:${tabId}`);
    await clickAndWait(env, 'toggle-input-watcher', /^input watcher: on/);
    const settle = () => sleep(1400); // the watcher's effect window is 1 s
    // (f) Type, then Tab away: a user focus move, not logged.
    await page.click('#plain');
    await page.keyboard.type('Sam', { delay: 40 });
    await page.keyboard.press('Tab');
    await settle();
    // (c) The page moves focus after the third digit.
    await page.click('#phone-area');
    await sleep(200);
    await page.keyboard.type('312', { delay: 60 });
    await settle();
    await page.click('#ship-other'); // (d)
    await settle();
    await page.click('#gift-yes'); // (e)
    await settle();
    await page.selectOption('#sort', 'price'); // (g)
    await settle();
    await page.click('#instock'); // (j) the page then runs filterButton.click()
    await settle();
    // (i) ArrowDown on a closed select changes its value; the page then
    // moves focus. Arrow keys outside a radio group are not a user focus move.
    // A label click focuses the select like a tester would (page.focus() is
    // a script focus, which the watcher rightly logs) and leaves it closed.
    await page.click('label[for="units"]');
    await page.keyboard.press('ArrowDown');
    await settle();
    const opened = env.ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await page.click('#newwin'); // (b)
    const newTab = await opened;
    check('[input-watcher] the checkbox opened a new tab', !!newTab);
    await sleep(800);
    if (newTab) await newTab.close();
    await page.bringToFront();
    await sleep(500);
    // Before the navigation: the open popup has synced the log once per new
    // entry on this page, and none of those incremental stores may turn a
    // finding found seconds earlier into "existing".
    const mid = await storedFindings(env, tabId, 'input-watcher');
    check('[input-watcher] incremental syncs keep every finding "new"', mid.length >= 5 && mid.every((x) => x.status === 'new'), JSON.stringify(mid.map((x) => [x.selector, x.status])));
    const firstUrl = page.url();
    await Promise.all([page.waitForURL(/country=ca/), page.selectOption('#country', 'ca')]); // (a)
    await page.waitForLoadState('load');
    await sleep(800);

    await env.popup.reload();
    await env.popup.waitForFunction(() => document.getElementById('report-summary'));
    await sleep(1500);
    const f = await storedFindings(env, tabId, 'input-watcher');
    for (const e of await expectations(env, tabId)) {
      const got = severityFor(f, e.sel);
      check(`[input-watcher] form-input.html #${e.id} → ${e.expect}`, got === e.expect, `got ${got}; findings: ${JSON.stringify(f.map((x) => [x.wcag, x.selector, x.details.slice(0, 140)]))}`);
    }
    const one = (sel, wcag) => f.find((x) => x.selector === sel && x.wcag === wcag) || { details: '' };
    const nav = one('#country', '3.2.2');
    check('[input-watcher] (a) navigation logged and kept after the page navigated', /The page navigated or reloaded to [^ ]*country=ca/.test(nav.details), nav.details);
    check('[input-watcher] (a) the finding keeps the URL of the page the field was on', nav.url === firstUrl, `${nav.url} vs ${firstUrl}`);
    // window.open tabs have no URL yet at tabs.onCreated, so none is asserted.
    check('[input-watcher] (b) new tab logged', /A new tab or window opened/.test(one('#newwin', '3.2.2').details), one('#newwin', '3.2.2').details);
    check('[input-watcher] (c) script focus move logged', /A script moved focus to #phone-rest/.test(one('#phone-area', '3.2.2').details), one('#phone-area', '3.2.2').details);
    check('[input-watcher] (d) content shown, not announced', /shown or added at #other-address/.test(one('#ship-other', '4.1.2').details) && /no live region changed/.test(one('#ship-other', '4.1.2').details), one('#ship-other', '4.1.2').details);
    check('[input-watcher] (e) content shown and announced', /shown or added at #gift-fields/.test(one('#gift-yes', '4.1.2').details) && /live region changed to "A gift message field was added below\."/.test(one('#gift-yes', '4.1.2').details), one('#gift-yes', '4.1.2').details);
    check('[input-watcher] (i) ArrowDown on a select, then a script focus move, is logged', /A script moved focus to #height/.test(one('#units', '3.2.2').details), one('#units', '3.2.2').details);
    check('[input-watcher] (j) a script click on the submit button is not a user action: submit logged', /A form was submitted/.test(one('#instock', '3.2.2').details), one('#instock', '3.2.2').details);
    check('[input-watcher] (g) form submit on change logged', /A form was submitted/.test(one('#sort', '3.2.2').details), one('#sort', '3.2.2').details);
    check('[input-watcher] a Tab press is not logged as a script focus move', !f.some((x) => /#after-plain/.test(x.details)), JSON.stringify(f.map((x) => x.details)));
    check('[input-watcher] the radio click focus is not logged as a script move', !/A script moved focus/.test(one('#ship-other', '3.2.2').details + one('#gift-yes', '3.2.2').details), one('#ship-other', '3.2.2').details + ' | ' + one('#gift-yes', '3.2.2').details);
    check('[input-watcher] every finding is review', f.length > 0 && f.every((x) => x.severity === 'review'));
    const dbgState = await env.popup.evaluate(async (k) => (await chrome.storage.session.get(k))[k] || null, `tab:${tabId}`);
    check('[input-watcher] the debugger was never attached', !dbgState || !dbgState.attached, JSON.stringify(dbgState));

    // After the navigation the page script is gone but the log is kept.
    const label = await env.popup.evaluate(() => document.getElementById('toggle-input-watcher').textContent);
    check('[input-watcher] popup offers to resume after the navigation', label === 'Resume watcher', label);
    await clickAndWait(env, 'toggle-input-watcher', /^input watcher: on, continuing a log/);

    // Type, Tab, then Space on the submit button: the user's own submit. The
    // navigation must not be logged against the field (Space fires click,
    // never pointerdown).
    await page.click('#search');
    await page.keyboard.type('abc', { delay: 40 });
    await page.keyboard.press('Tab');
    await Promise.all([page.waitForURL(/q=abc/), page.keyboard.press('Space')]);
    await page.waitForLoadState('load');
    await sleep(800);
    await env.popup.reload();
    await env.popup.waitForFunction(() => document.getElementById('toggle-input-watcher').textContent === 'Resume watcher', null, { timeout: 5000 }).catch(() => {});
    await sleep(800);
    const f2 = await storedFindings(env, tabId, 'input-watcher');
    check('[input-watcher] Tab then Space on a submit button: no finding on the field', !f2.some((x) => x.selector === '#search'), JSON.stringify(f2.filter((x) => x.selector === '#search').map((x) => x.details)));
    check('[input-watcher] the log continued across both navigations', f2.length === f.length, `${f2.length} vs ${f.length}`);
    await clickAndWait(env, 'toggle-input-watcher', /^input watcher: on, continuing a log/);

    // Stop less than 1 s after a change: the open window's effect still
    // reaches the final log (a second identical content change on the field).
    // The Stop click goes through evaluate(): Playwright's click on the
    // background popup tab can take longer than the 1 s window.
    await page.click('#ship-other');
    await env.popup.evaluate(() => {
      document.getElementById('status').textContent = '';
      document.getElementById('toggle-input-watcher').click();
    });
    await env.popup.waitForFunction(() => /^input watcher: off/.test(document.getElementById('status').textContent));
    const f3 = await storedFindings(env, tabId, 'input-watcher');
    const ship = (f3.find((x) => x.selector === '#ship-other' && x.wcag === '4.1.2') || {}).details || '';
    // The same field logged changes on two pages: one finding (one
    // fingerprint), each sentence naming its page. The q=abc one is the
    // window that was still open at Stop.
    check('[input-watcher] Stop right after a change keeps the effect of the open window', /#other-address[^]*\(On [^ ]*form-input\.html\?q=abc\.\)/.test(ship), ship);
    check('[input-watcher] changes on two pages: one finding, both pages named', /\(On [^ ]*form-input\.html\.\)/.test(ship) && f3.filter((x) => x.selector === '#ship-other' && x.wcag === '4.1.2').length === 1, ship);
    // Start again to test that Stop removes everything.
    await clickAndWait(env, 'toggle-input-watcher', /^input watcher: on/);
    // Stop removes everything the watcher added, and its SW log; the findings stay.
    await clickAndWait(env, 'toggle-input-watcher', /^input watcher: off/);
    const marker = await page.evaluate(() => document.documentElement.hasAttribute('data-a11y-input-watcher'));
    const log = await env.popup.evaluate(async (k) => (await chrome.storage.session.get(k))[k] || null, `watch:${tabId}`);
    check('[input-watcher] Stop removes the page marker and the SW log', !marker && !log, JSON.stringify({ marker, log }));
    check('[input-watcher] findings stay after Stop', (await storedFindings(env, tabId, 'input-watcher')).length === f3.length);
    await page.close();
  }
  await env.ctx.close();
} catch (e) {
  check('script error', false, e.stack);
} finally {
  server.close();
}

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
