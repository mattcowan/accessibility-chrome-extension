// Headless runner (#33): runs the extension's checkers on one URL with no
// browser window and writes the findings as JSON and/or CSV. For scripts, CI
// jobs and agents that cannot click Run in the popup.
//
//   node tools/headless-run/run.mjs <url|file> [--checkers id,id]
//     [--reduced-motion] [--reflow 320|320zoom] [--json file|-] [--csv file|-]
//     [--settle ms] [--timeout s]
//
// Needs the scanner's Playwright install (`cd tools/keyboard-trap-scan &&
// npm ci && npx playwright install chromium`). Run with --help for the
// options and the checker ids.
//
// How it works: it drives the popup's own code, exactly as a person would,
// so the findings are the popup's (the same CHECKERS registry, batch order,
// SW `exec` route and findings store):
// - The extension is staged to a temp folder with host_permissions added (as
//   tools/e2e/verify.mjs does), so injection needs no activeTab click. The
//   shipped manifest.json is never changed.
// - Chromium runs headless (`channel: 'chromium'`: the full build in new
//   headless mode; the default headless shell does not load extensions).
// - popup.html opens in one tab and the URL in another; the popup is reloaded
//   with the target as the active tab, so it binds to it. The batch
//   selection is written to chrome.storage.local first, so the popup comes up
//   with exactly the asked boxes ticked; then the runner clicks Run selected.
// - It reads the results from the popup's chrome.storage.session keys
//   `findings:${tabId}` and `batch:${tabId}` (the batch outcome). A checker
//   the batch could not run becomes a '(page)' review, never "0 findings".
// - It never calls page.evaluate (or any script) in the target page: that
//   carries a user gesture and gives the page user activation (#15).
//
// Exit codes: 0 no fail finding; 1 at least one fail; 2 usage or run error.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`${msg}\n`);

class UsageError extends Error {}

// ---------------------------------------------------------------- checkers

// The batch checkers and their "Run selected" defaults, read from the
// CHECKERS registry in popup.js (the one source; checked again against the
// popup's checkboxes at run time). Each entry starts with `id:` and ends with
// `batchDefault:`.
function readRegistry() {
  const src = fs.readFileSync(path.join(REPO, 'popup', 'popup.js'), 'utf8');
  const block = src.match(/\nconst CHECKERS = \[([\s\S]*?)\n\];/);
  const entries = block ? [...block[1].matchAll(/\bid: '([\w-]+)'[\s\S]*?\bbatchDefault: (true|false)/g)] : [];
  if (!entries.length) throw new Error('Could not read the CHECKERS registry from popup/popup.js.');
  return entries.map(([, id, def]) => ({ id, batchDefault: def === 'true' }));
}

// The Reflow checker runs only with the 320 px viewport on (its registry gate).
const REFLOW_ID = 'reflow';

// --------------------------------------------------------------------- args

const HELP = `Usage: node tools/headless-run/run.mjs <url|file> [options]

Runs the extension's batch checkers ("Run selected") on one page in headless
Chromium and writes the findings. <file> is a local HTML file; its folder is
served over http://127.0.0.1 (extensions cannot run on file:// pages).

Options:
  --checkers <id,id>   Checkers to run, in registry order whatever the order
                       given. Default: the ones ticked by default in Run selected.
  --reduced-motion     Emulate prefers-reduced-motion: reduce first.
  --reflow <320|320zoom>
                       Turn on the Reflow test viewport first (320 CSS px;
                       320zoom renders it at 400% zoom). Needed by "reflow".
  --json <file|->      Write the findings as a JSON array ("-" = stdout).
  --csv <file|->       Write the findings as CSV (popup/csv.js columns).
                       With neither, the JSON goes to stdout.
  --settle <ms>        Wait after the page loads, before checking (default 1500).
  --timeout <s>        Give up on the batch after this long (default 600).
  -h, --help           Show this help.

Exit codes: 0 no fail finding, 1 at least one fail, 2 usage or run error.
Progress and the summary go to stderr.`;

function parseCli(argv, registry) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      checkers: { type: 'string' },
      'reduced-motion': { type: 'boolean', default: false },
      reflow: { type: 'string' },
      json: { type: 'string' },
      csv: { type: 'string' },
      settle: { type: 'string', default: '1500' },
      timeout: { type: 'string', default: '600' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new UsageError('Give exactly one URL or file.');

  const valid = registry.map((c) => c.id);
  const reflow = values.reflow ?? false;
  if (reflow && !['320', '320zoom'].includes(reflow)) {
    throw new UsageError(`--reflow must be 320 or 320zoom, not "${reflow}".`);
  }
  let ids;
  if (values.checkers !== undefined) {
    const asked = values.checkers.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = asked.filter((id) => !valid.includes(id));
    if (unknown.length || !asked.length) {
      throw new UsageError(
        `${unknown.length ? `Unknown checker id: ${unknown.join(', ')}.` : 'No checker ids given.'} ` +
          `Valid ids: ${valid.join(', ')}.`
      );
    }
    if (asked.includes(REFLOW_ID) && !reflow) {
      throw new UsageError('The reflow checker needs the Reflow test viewport: add --reflow 320 (or 320zoom).');
    }
    ids = new Set(asked);
  } else {
    // The popup ticks reflow by default but disables its box until the
    // Reflow viewport is on, so the batch skips it; so does this.
    ids = new Set(registry.filter((c) => c.batchDefault && (c.id !== REFLOW_ID || reflow)).map((c) => c.id));
  }
  // Run selected runs the hover probe's own static pass, never both.
  if (ids.has('hover-probe')) ids.delete('hover-static');

  const settle = Number(values.settle);
  const timeout = Number(values.timeout);
  if (!Number.isFinite(settle) || settle < 0) throw new UsageError('--settle takes milliseconds (0 or more).');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError('--timeout takes seconds (more than 0).');

  return {
    target: positionals[0],
    ids,
    reducedMotion: values['reduced-motion'],
    reflow,
    json: values.json ?? (values.csv === undefined ? '-' : undefined),
    csv: values.csv,
    settleMs: settle,
    timeoutMs: timeout * 1000,
  };
}

// --------------------------------------------------------------- the target

const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.vtt': 'text/vtt', '.woff2': 'font/woff2',
};

// A local file's folder over http on 127.0.0.1 (extensions cannot inject
// into file:// pages without a per-extension setting).
async function serveFolder(root) {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(p));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

// -> {url, server}. A file path may carry ?query or #hash (fixtures use them).
async function resolveTarget(target) {
  let url = null;
  try {
    url = new URL(target);
  } catch {
    // not a URL: a file path
  }
  if (url && /^https?:$/.test(url.protocol)) return { url: url.href, server: null };
  let file;
  let suffix = '';
  if (url && url.protocol === 'file:') {
    file = fileURLToPath(new URL(url.origin + url.pathname));
    suffix = url.search + url.hash;
  } else if (url && url.protocol.length > 2) {
    // (a one-letter "protocol" is a Windows drive letter: a file path)
    throw new UsageError(`Extensions cannot run on ${url.protocol} pages. Give an http(s) URL or a local file.`);
  } else {
    const m = target.match(/^([^?#]*)(.*)$/);
    file = path.resolve(fs.existsSync(target) ? target : m[1]);
    suffix = fs.existsSync(target) ? '' : m[2];
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    throw new UsageError(`Not an http(s) URL or an HTML file: ${target}`);
  }
  const { server, base } = await serveFolder(path.dirname(file));
  return { url: base + encodeURIComponent(path.basename(file)) + suffix, server };
}

// ---------------------------------------------------------------- the run

function stage(work) {
  const ext = path.join(work, 'extension');
  for (const dir of ['background', 'checkers', 'popup', 'icons']) {
    fs.cpSync(path.join(REPO, dir), path.join(ext, dir), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return ext;
}

function loadPlaywright() {
  const require = createRequire(path.join(REPO, 'tools', 'keyboard-trap-scan', 'x.js'));
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed. Run: cd tools/keyboard-trap-scan && npm ci && npx playwright install chromium'
    );
  }
}

// A '(page)' review for a checker the batch could not run. Joins the tool's
// own '(page)' finding if it has one (one per tool keeps the fingerprint
// unique), as the popup does.
function addRunError(findings, err, url, timestamp) {
  const details = err.skipped
    ? `The ${err.tool} check did not run (${err.error}). Check WCAG ${err.wcag} by hand, or run it again.`
    : `The ${err.tool} check failed, so the page was not checked for it: ${err.error.replace(/\.?$/, '.')} ` +
      `Run it again, or check WCAG ${err.wcag} by hand.`;
  const page = findings.find((f) => f.tool === err.tool && f.selector === '(page)');
  if (page) page.details += ` ${details}`;
  else {
    findings.push({
      tool: err.tool, wcag: err.wcag, severity: 'review', selector: '(page)', snippet: '',
      details, url, timestamp, status: 'new',
    });
  }
}

async function run(opts, registry, columns) {
  const { chromium } = loadPlaywright();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-headless-'));
  const removeWork = () => fs.rmSync(work, { recursive: true, force: true });
  process.on('exit', removeWork);
  const ext = stage(work);
  const { url, server } = await resolveTarget(opts.target);
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
      headless: true,
      channel: 'chromium',
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--mute-audio'],
      // Playwright hides scrollbars in headless mode. A page then gets the
      // scrollbar's width back (320 px at the Reflow viewport, not ~305), so
      // its layout and widths differ from a headed Chrome on Windows or Linux.
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup/popup.html`;

    const popup = ctx.pages()[0] || (await ctx.newPage());
    popup.on('pageerror', (e) => log(`popup error: ${e.message}`));
    await popup.goto(popupUrl);
    const all = registry.map((c) => c.id);
    const selection = Object.fromEntries(all.map((id) => [id, opts.ids.has(id)]));
    await popup.evaluate((s) => chrome.storage.local.set({ batchSelection: s }), selection);

    log(`Loading ${url}`);
    const page = await ctx.newPage();
    const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (response && !response.ok()) log(`Warning: the page answered HTTP ${response.status()}.`);
    await page.bringToFront();
    await sleep(opts.settleMs);

    // Reloaded with the page as the active tab, the popup binds to it.
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('report-summary'));
    const tab = await popup.evaluate(async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t && { id: t.id, url: t.url };
    });
    if (!tab || tab.url.startsWith('chrome-extension:')) throw new Error('The popup did not bind to the page.');
    if (await popup.isVisible('#restricted-msg')) {
      throw new Error(`Chrome does not let extensions run on this page: ${tab.url}`);
    }

    // Emulation, through the same SW messages as the popup's toggles.
    const emulate = async (msg) => {
      const res = await popup.evaluate((m) => chrome.runtime.sendMessage(m), { ...msg, tabId: tab.id });
      if (!res || !res.ok) throw new Error(`Could not apply ${msg.type}: ${(res && res.error) || 'no response'}`);
    };
    if (opts.reducedMotion) {
      await emulate({ type: 'setMediaFeature', feature: 'prefers-reduced-motion', value: 'reduce' });
    }
    if (opts.reflow) await emulate({ type: 'setReflow', value: opts.reflow });
    if (opts.reducedMotion || opts.reflow) await sleep(500); // let the page react (media query, resize)

    // The boxes come up from the stored selection; the reflow box is enabled
    // once the popup has the Reflow state (stateChanged).
    const wanted = [...opts.ids];
    try {
      await popup.waitForFunction(
        (ids) => {
          const boxes = [...document.querySelectorAll('.batch-select')];
          return ids.every((id) => boxes.some((b) => b.dataset.batchId === id && b.checked && !b.disabled)) &&
            boxes.every((b) => ids.includes(b.dataset.batchId) || !b.checked);
        },
        wanted,
        { timeout: 10000 }
      );
    } catch {
      const boxes = await popup.$$eval('.batch-select', (bs) =>
        bs.map((b) => `${b.dataset.batchId}${b.checked ? ' ticked' : ''}${b.disabled ? ' disabled' : ''}`)
      );
      throw new Error(`The popup's Run selected boxes did not match ${wanted.join(', ')}: ${boxes.join('; ')}`);
    }

    const keys = [`findings:${tab.id}`, `batch:${tab.id}`];
    await popup.evaluate((k) => chrome.storage.session.remove(k), keys);
    log(`Running ${wanted.length} checker${wanted.length === 1 ? '' : 's'}: ${all.filter((id) => opts.ids.has(id)).join(', ')}`);
    await popup.click('#run-selected');

    // Wait for the batch outcome; echo the popup's progress line meanwhile.
    const end = Date.now() + opts.timeoutMs;
    let batch = null;
    let shown = '';
    while (!batch) {
      if (Date.now() > end) throw new Error(`The batch did not finish within ${opts.timeoutMs / 1000} s.`);
      await sleep(250);
      const st = await popup.evaluate(async (k) => ({
        batch: (await chrome.storage.session.get(k))[k] || null,
        progress: document.getElementById('batch-progress').textContent,
      }), keys[1]);
      batch = st.batch;
      if (st.progress && st.progress !== shown) log(`  ${(shown = st.progress)}`);
    }

    const store = (await popup.evaluate(async (k) => (await chrome.storage.session.get(k))[k], keys[0])) || { tools: {} };
    const findings = Object.values(store.tools).flatMap((data) => data.findings.concat(data.resolved || []));
    const now = new Date().toISOString();
    for (const err of batch.errors) addRunError(findings, err, store.url || tab.url, now);
    return {
      url: store.url || tab.url,
      ran: batch.ran,
      errors: batch.errors,
      findings: findings.map((f) => Object.fromEntries(columns.map((c) => [c, f[c] ?? '']))),
    };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    // An open server would keep Node running.
    if (server) server.close();
  }
}

function write(dest, text) {
  if (dest === '-') process.stdout.write(text);
  else fs.writeFileSync(dest, text);
}

async function main() {
  let opts;
  let registry;
  try {
    registry = readRegistry();
    opts = parseCli(process.argv.slice(2), registry);
  } catch (e) {
    log(e instanceof UsageError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
      ? `${e.message}\nRun with --help for the options.`
      : e.message);
    return 2;
  }
  if (opts.help) {
    log(HELP);
    log(`\nChecker ids (registry order; * = default): ${registry.map((c) => `${c.id}${c.batchDefault ? '*' : ''}`).join(', ')}`);
    return 0;
  }

  // popup/csv.js is an ES module in a folder with no package.json; a copy
  // named .mjs imports on any Node version.
  const csvCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-csv-')), 'csv.mjs');
  fs.copyFileSync(path.join(REPO, 'popup', 'csv.js'), csvCopy);
  const { COLUMNS, toCsv } = await import(pathToFileURL(csvCopy).href);
  fs.rmSync(path.dirname(csvCopy), { recursive: true, force: true });

  let result;
  try {
    result = await run(opts, registry, COLUMNS);
  } catch (e) {
    log(e instanceof UsageError ? e.message : `Run failed: ${e.message}`);
    return 2;
  }

  const { findings, url, errors, ran } = result;
  if (opts.json) write(opts.json, `${JSON.stringify(findings, null, 2)}\n`);
  if (opts.csv) write(opts.csv, toCsv(findings, { url, exported: new Date().toISOString() }));

  const current = findings.filter((f) => f.status !== 'resolved');
  const count = (sev) => current.filter((f) => f.severity === sev).length;
  log(`${current.length} findings — ${count('fail')} fail, ${count('warn')} warn, ${count('review')} review ` +
    `(${ran} checker${ran === 1 ? '' : 's'} ran) on ${url}`);
  for (const e of errors) log(`  ${e.tool}: ${e.skipped ? 'skipped — ' : 'failed — '}${e.error}`);
  return count('fail') ? 1 : 0;
}

process.exitCode = await main();
