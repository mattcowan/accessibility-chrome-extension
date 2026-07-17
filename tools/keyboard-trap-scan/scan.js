#!/usr/bin/env node
// Keyboard-trap scanner (WCAG 2.1.2).
//
// Presses REAL Tab keys via Playwright (trusted events — the reason this is
// not a browser-extension feature) and watches where focus goes. Detects:
//   - stuck focus (same element absorbing repeated Tabs)
//   - focus cycles among a subset while unvisited focusables remain
//   - focus lost to <body> mid-sequence
// Before flagging a trap it probes escapability with Shift+Tab and Escape:
// an escapable trap is a 'warn' (verify users are told the exit method);
// an inescapable one is a 'fail' and the scan stops.
//
// Usage: node scan.js <url> [--max-tabs 200] [--out report.csv] [--headed]

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { HELPERS_SOURCE } from './lib/focusables.js';
import { toCsv } from './lib/csv.js';

function parseArgs(argv) {
  const args = { url: null, maxTabs: 200, out: 'report.csv', headed: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-tabs') args.maxTabs = parseInt(argv[++i], 10) || 200;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  if (!args.url) {
    console.error('Usage: node scan.js <url> [--max-tabs 200] [--out report.csv] [--headed]');
    process.exit(2);
  }
  return args;
}

function finding(url, severity, selector, details) {
  return {
    tool: 'keyboard-trap-scan',
    wcag: '2.1.2',
    severity,
    selector,
    snippet: '',
    details,
    url,
    timestamp: new Date().toISOString(),
    status: '',
  };
}

// Do the last 2k entries of seq form the same cycle of length k twice?
function detectCycle(seq) {
  for (let k = 2; k <= 12; k++) {
    if (seq.length < 2 * k) continue;
    const tail = seq.slice(-2 * k);
    let match = true;
    for (let i = 0; i < k; i++) {
      if (tail[i].id !== tail[i + k].id) {
        match = false;
        break;
      }
    }
    if (match) return tail.slice(0, k);
  }
  return null;
}

async function probeEscape(page, cycleIds, cycleLen) {
  // 1) Can Shift+Tab leave the cycle?
  for (let i = 0; i <= cycleLen; i++) {
    await page.keyboard.press('Shift+Tab');
    const d = await page.evaluate(() => window.__kt.describeActive());
    if (!cycleIds.has(d.id)) return 'shift-tab';
  }
  // 2) Does Escape release the trap for forward tabbing?
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  const d = await page.evaluate(() => window.__kt.describeActive());
  if (!cycleIds.has(d.id)) return 'escape';
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const findings = [];
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage();
  await page.addInitScript(HELPERS_SOURCE);

  console.log(`Scanning ${args.url} (max ${args.maxTabs} Tab presses)...`);
  await page.goto(args.url, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const total = await page.evaluate(() => window.__kt.countFocusables());
  console.log(`Focusable elements detected: ${total}`);

  const seq = [];
  const seen = new Set();
  let bodyWraps = 0;
  let lostFocusReported = 0;
  let consecutiveSame = 0;
  let trap = null;

  for (let i = 0; i < args.maxTabs; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => window.__kt.describeActive());

    if (d.atBody) {
      // Normal wrap boundary when coverage is high; suspicious otherwise.
      bodyWraps++;
      if (seen.size >= total * 0.9) break; // full pass complete
      if (bodyWraps > 2 && lostFocusReported < 3) {
        lostFocusReported++;
        const prev = seq[seq.length - 1];
        findings.push(
          finding(
            args.url,
            'warn',
            prev ? prev.selector : '(page)',
            `Focus returned to <body> mid-sequence (after ${prev ? prev.selector : 'start'}) with only ${seen.size}/${total} focusables visited — possible focus loss or unreachable content.`
          )
        );
      }
      consecutiveSame = 0;
      continue;
    }

    const prev = seq[seq.length - 1];
    seq.push(d);
    seen.add(d.id);
    consecutiveSame = prev && prev.id === d.id ? consecutiveSame + 1 : 0;

    if (consecutiveSame >= 2) {
      trap = { members: [d], kind: 'stuck' };
    } else {
      const cycle = detectCycle(seq);
      if (cycle && seen.size < total) {
        trap = { members: cycle, kind: 'cycle' };
      }
    }

    if (trap) {
      const cycleIds = new Set(trap.members.map((m) => m.id));
      const memberList = trap.members.map((m) => m.selector).join('; ');
      console.log(`Suspected ${trap.kind} trap at: ${memberList} — probing escapability...`);
      const escape = await probeEscape(page, cycleIds, trap.members.length);
      if (escape === 'shift-tab') {
        findings.push(
          finding(
            args.url,
            'warn',
            trap.members[0].selector,
            `Forward-Tab ${trap.kind} among [${memberList}] (${seen.size}/${total} focusables reached), but Shift+Tab escapes. Not a hard 2.1.2 trap; forward keyboard flow is still broken — investigate.`
          )
        );
      } else if (escape === 'escape') {
        findings.push(
          finding(
            args.url,
            'warn',
            trap.members[0].selector,
            `Keyboard trap among [${memberList}] escapable only via Escape. WCAG 2.1.2 requires the user be advised of non-standard exit methods — verify instructions exist.`
          )
        );
      } else {
        findings.push(
          finding(
            args.url,
            'fail',
            trap.members[0].selector,
            `Hard keyboard trap: focus cycles among [${memberList}] and neither Shift+Tab nor Escape frees it. ${seen.size}/${total} focusables were reachable before the trap. Fails WCAG 2.1.2.`
          )
        );
        console.log('Hard trap confirmed — stopping scan.');
        break;
      }
      // Escapable: scanning past the trap would just re-enter it.
      console.log('Trap is escapable — stopping scan (continuing would re-enter it).');
      break;
    }

    // Normal completion: wrapped back to the first element with high coverage.
    if (seq.length > 1 && d.id === seq[0].id && seen.size >= total * 0.9) break;
  }

  const summary = `Visited ${seen.size} of ${total} detected focusables in ${seq.length} Tab presses. ${
    findings.filter((f) => f.severity === 'fail').length
  } fail / ${findings.filter((f) => f.severity === 'warn').length} warn findings.`;
  if (seen.size < total && !findings.some((f) => f.severity === 'fail')) {
    findings.push(
      finding(
        args.url,
        'review',
        '(page)',
        `Coverage: ${summary} Unreached focusables may be intentionally hidden (menus, dialogs) or unreachable — verify manually.`
      )
    );
  }

  await writeFile(args.out, toCsv(findings), 'utf8');
  console.log(summary);
  console.log(`Report written to ${args.out} (${findings.length} rows).`);
  await browser.close();
  process.exitCode = findings.some((f) => f.severity === 'fail') ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
