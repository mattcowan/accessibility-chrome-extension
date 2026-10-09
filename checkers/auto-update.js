// Auto-updating content checker (WCAG 2.2.2 Pause, Stop, Hide / Trusted
// Tester 2.C) and the notification each update gives (Trusted Tester 2.D,
// reported under WCAG 4.1.2 as Trusted Tester maps it). Watch-only and top
// frame only: it never clicks, scrolls, focuses or presses keys.
//   __a11yCheckers.autoUpdate({action: 'start', seconds}) -> {active, seconds}
//       Starts watching now; the watch ends on its own after `seconds`.
//       {busy: true} when a watch is already running (popup + side panel).
//   __a11yCheckers.autoUpdate({action: 'collect'})
//       -> Promise<{findings, watchedMs, regions, inputs}>
//       Waits for the watch to end, then reports. {missing: true} when this
//       document never started a watch (the page navigated or reloaded
//       during it, so the popup must not report a clean page). The popup waits out the
//       watch in its own page (with a countdown) rather than inside one long
//       executeScript, so no single call outlives a service-worker timeout.
//   __a11yCheckers.autoUpdate({action: 'status'}) -> {active, seconds}
// Needs selector.js, findings.js, accname.js, mechanism.js and lib/live.js.
//
// What counts as an update: a MutationObserver sees text, child-list and
// show/hide attribute changes (class, style, hidden, aria-hidden, src, open);
// a 200 ms sampler sees scroll-position changes of overflow containers
// (carousels that move with scrollLeft fire no mutations). Changes closer
// than BURST_GAP_MS are one update. A region is reported when it updated
// twice or more, or when one update ran CONTINUOUS_MS or longer (a ticker that
// a script moves every frame). Content that moves only by a CSS animation or
// transition makes no DOM change; the motion checker reports those.
globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

if (!globalThis.__a11yAutoUpdate) {
  globalThis.__a11yAutoUpdate = true;

  (function () {
    const F = globalThis.__a11yFindings;
    const { regionOf, politenessFor } = globalThis.__a11yLive;

    const DEFAULT_SECONDS = 10;
    const MAX_SECONDS = 300;
    const BURST_GAP_MS = 300; // changes closer than this are one update
    const CONTINUOUS_MS = 2000; // one update this long = content that keeps changing
    const INPUT_IGNORE_MS = 1000; // changes this soon after user input are the user's
    const NOTIFY_MS = 1000; // a focus move, dialog or live change this soon after an update notifies it
    const SCROLL_SAMPLE_MS = 200;
    const DIALOG_REPEATS = 3; // dialogs elsewhere must open with this many updates
    const MAX_SCROLLERS = 200;
    const MERGE_DEPTH = 3; // "next to" for a live region: an ancestor this many levels up
    const WATCHED_ATTRS = ['class', 'style', 'hidden', 'aria-hidden', 'src', 'open'];
    // Trusted input only; pointerdown covers mouse, pen and touch (one event
    // per click, so the note's count is right). Not mousemove: the tester's
    // resting pointer is no action, and hover-only changes do not repeat on
    // their own.
    const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'];
    const NOISE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
    // Every dialog, open or not; "open" = rendered (a closed <dialog> is
    // display: none).
    const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]';
    const OBSERVE = {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: WATCHED_ATTRS,
    };

    let watch = null; // the running or the last finished watch

    // Other tools' on-page UI (overlay, focus locator, live-region panels).
    const isTool = (el) => !!(el.closest && el.closest('[id^="__a11y"], .__a11y-live-panel'));

    // Parent across shadow boundaries.
    function composedParent(el) {
      if (el.parentElement) return el.parentElement;
      const root = el.getRootNode();
      return root && root.host ? root.host : null;
    }

    function insideBody(el) {
      let top = el;
      while (top.getRootNode() instanceof ShadowRoot) top = top.getRootNode().host;
      return !!document.body && document.body.contains(top) && top !== document.body;
    }

    function rendered(el) {
      try {
        return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      } catch {
        return false;
      }
    }

    // Logs a dialog only when it OPENS: w.openDialogs holds the ones already
    // shown (seeded at start), so a class or style change on an open dialog
    // is not a new dialog.
    function noteDialog(w, el, at) {
      if (el.nodeType !== Node.ELEMENT_NODE || !el.matches(DIALOG_SELECTOR)) return;
      if (rendered(el)) {
        if (!w.openDialogs.has(el)) {
          w.openDialogs.add(el);
          w.dialogs.push({ el, at });
        }
      } else {
        w.openDialogs.delete(el);
      }
    }

    const now = () => performance.now();

    // kind: 'style' (an inline style write only), 'scroll', or 'content'.
    function record(w, el, at, kind) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return;
      if (isTool(el) || !insideBody(el)) return;
      w.changes.push({ el, at, kind, live: !!regionOf(el) });
    }

    const textOf = (nodes) => [...nodes].map((n) => n.textContent).join('');
    const isNoise = (n) =>
      n.nodeType === Node.COMMENT_NODE ||
      (n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) ||
      (n.nodeType === Node.ELEMENT_NODE && NOISE_TAGS.has(n.tagName));

    function onMutations(w, records) {
      const at = now();
      // One change per element per callback; 'content' wins over 'style'.
      const seen = new Map();
      const add = (el, kind) => {
        if (el && seen.get(el) !== 'content') seen.set(el, kind);
      };
      for (const m of records) {
        if (m.type === 'attributes') {
          // Frameworks often re-set an attribute to the value it had.
          if (m.target.getAttribute(m.attributeName) === m.oldValue) continue;
          add(m.target, m.attributeName === 'style' ? 'style' : 'content');
          noteDialog(w, m.target, at);
        } else if (m.type === 'characterData') {
          if (m.target.textContent === m.oldValue) continue;
          add(m.target.parentElement, 'content');
        } else {
          const added = [...m.addedNodes].filter((n) => !isNoise(n));
          const removed = [...m.removedNodes].filter((n) => !isNoise(n));
          if (!added.length && !removed.length) continue;
          // Text replaced with the same text (a re-render) is no update.
          const allText = [...added, ...removed].every((n) => n.nodeType === Node.TEXT_NODE);
          if (allText && textOf(added) === textOf(removed)) continue;
          add(m.target instanceof ShadowRoot ? m.target.host : m.target, 'content');
          for (const n of added) {
            if (n.nodeType !== Node.ELEMENT_NODE) continue;
            noteDialog(w, n, at);
            for (const d of n.querySelectorAll(DIALOG_SELECTOR)) noteDialog(w, d, at);
          }
        }
      }
      for (const [el, kind] of seen) record(w, el, at, kind);
    }

    function shadowRoots() {
      const out = [];
      (function walk(root) {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            out.push(el.shadowRoot);
            walk(el.shadowRoot);
          }
        }
      })(document);
      return out;
    }

    // Overflow containers that can scroll (not the page itself: the page
    // scrolls when the user scrolls). capped: there were more than
    // MAX_SCROLLERS, and the rest are not sampled (the page note says so).
    function scrollers() {
      const list = [];
      const all = [];
      if (!document.body) return { list, capped: false };
      F.collectMatching(document.body, '*', all);
      for (const el of all) {
        if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
        const s = getComputedStyle(el);
        if (!/auto|scroll|hidden/.test(`${s.overflowX} ${s.overflowY}`)) continue;
        if (isTool(el)) continue;
        if (list.length >= MAX_SCROLLERS) return { list, capped: true };
        list.push({ el, x: el.scrollLeft, y: el.scrollTop });
      }
      return { list, capped: false };
    }

    function start(seconds) {
      if (watch && !watch.finished) return { active: true, busy: true, seconds: watch.seconds };
      const w = {
        seconds,
        startedAt: now(),
        endedAt: null,
        finished: false,
        changes: [],
        inputs: [],
        focusins: [],
        dialogs: [], // [{el, at}] for each dialog that opened during the watch
        openDialogs: new Set([...document.querySelectorAll(DIALOG_SELECTOR)].filter(rendered)),
        scrollersCapped: false,
      };
      const observer = new MutationObserver((records) => onMutations(w, records));
      observer.observe(document.documentElement, OBSERVE);
      for (const root of shadowRoots()) observer.observe(root, OBSERVE);

      const scroll = scrollers();
      w.scrollersCapped = scroll.capped;
      const sampler = setInterval(() => {
        const at = now();
        for (const s of scroll.list) {
          if (!s.el.isConnected) continue;
          if (s.el.scrollLeft !== s.x || s.el.scrollTop !== s.y) {
            s.x = s.el.scrollLeft;
            s.y = s.el.scrollTop;
            record(w, s.el, at, 'scroll');
          }
        }
      }, SCROLL_SAMPLE_MS);

      const onInput = (e) => {
        if (e.isTrusted) w.inputs.push(now());
      };
      const onFocus = (e) => w.focusins.push({ el: e.composedPath()[0], at: now() });
      for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
      document.addEventListener('focusin', onFocus, true);

      w.done = new Promise((resolve) => {
        w.timer = setTimeout(() => {
          onMutations(w, observer.takeRecords());
          observer.disconnect();
          clearInterval(sampler);
          for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
          document.removeEventListener('focusin', onFocus, true);
          w.endedAt = now();
          w.finished = true;
          resolve();
        }, seconds * 1000);
      });
      watch = w;
      return { active: true, seconds };
    }

    // Nearest ancestor-or-self that makes a box of its own (not inline, not
    // display: none or contents) — a hidden slide resolves to its track.
    function blockOf(el) {
      for (let e = el; e && e !== document.body && e !== document.documentElement; e = composedParent(e)) {
        let display;
        try {
          display = getComputedStyle(e).display;
        } catch {
          continue;
        }
        if (display === 'none' || display === 'contents' || display === 'inline') continue;
        return e;
      }
      return null;
    }

    const isPageRoot = (el) => !el || el === document.body || el === document.documentElement;

    // Group changes by region: each change's block, then (until stable)
    // sibling blocks with the same tag merge into their parent (a carousel's
    // slides), and a block merges into its parent when the parent changed too
    // (a shown slide into its track). Only the parent: a one-time insertion
    // into a page wrapper (#root, #app) a few levels up must not swallow a
    // carousel inside it. Never up to <body>.
    function groupChanges(changes) {
      const groups = new Map();
      for (const c of changes) {
        const b = blockOf(c.el);
        if (!b) continue;
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(c);
      }
      const merge = (from, into) => {
        if (!groups.has(into)) groups.set(into, []);
        groups.get(into).push(...groups.get(from));
        groups.delete(from);
      };
      for (let changed = true; changed; ) {
        changed = false;
        const byParent = new Map();
        for (const b of groups.keys()) {
          const p = composedParent(b);
          if (isPageRoot(p)) continue;
          // Never merge a live block with a silent one: the merged region
          // would count as live and hide the silent block's 2.D failure.
          const key = `${b.tagName}|${groups.get(b).every((c) => c.live)}`;
          if (!byParent.has(p)) byParent.set(p, new Map());
          const tags = byParent.get(p);
          if (!tags.has(key)) tags.set(key, []);
          tags.get(key).push(b);
        }
        for (const [p, tags] of byParent) {
          for (const kids of tags.values()) {
            if (kids.length < 2) continue;
            for (const k of kids) merge(k, p);
            changed = true;
          }
        }
        for (const b of [...groups.keys()]) {
          const a = composedParent(b);
          if (!isPageRoot(a) && groups.has(a)) {
            merge(b, a);
            changed = true;
          }
        }
      }
      return groups;
    }

    function burstsOf(times) {
      const out = [];
      for (const t of times) {
        const last = out[out.length - 1];
        if (last && t - last.end <= BURST_GAP_MS) last.end = t;
        else out.push({ start: t, end: t });
      }
      return out;
    }

    function stats(list) {
      const times = list.map((c) => c.at).sort((a, b) => a - b);
      const bursts = burstsOf(times);
      const longest = Math.max(...bursts.map((b) => b.end - b.start));
      return { bursts, longest, qualifies: bursts.length >= 2 || longest >= CONTINUOUS_MS };
    }

    const secs = (ms) => {
      const s = ms / 1000;
      return s >= 10 ? String(Math.round(s)) : s.toFixed(1).replace(/\.0$/, '');
    };

    function updateSentence(st, watchedMs) {
      const n = st.bursts.length;
      let s = `It updated on its own ${n} time${n === 1 ? '' : 's'} in ${Math.round(watchedMs / 1000)} seconds`;
      if (n >= 2) s += `, about every ${secs((st.bursts[n - 1].start - st.bursts[0].start) / (n - 1))} seconds`;
      if (st.longest >= CONTINUOUS_MS) s += `; one update kept changing for ${secs(st.longest)} seconds`;
      return `${s}.`;
    }

    // How the user is told about the updates (TT 2.D), or null for none.
    // "Scope" = the region's ancestor at most MERGE_DEPTH levels up (never
    // body): what counts as "next to" the content.
    //  1. live: every change is inside a live region.
    //  2. live-beside: a live region in scope (a carousel's "Slide 2 of 4"
    //     status beside its track) changed within NOTIFY_MS of at least half
    //     of the silent updates AND changed about as often (±1). A live
    //     counter beside the content that updates on its own schedule fails
    //     the second test. One that changes at the very same moments cannot
    //     be told from a slide status, so that stays review.
    //  3. focus: focus moved into the region near an update.
    //  4. dialog: a dialog OPENED near an update, and it holds the region or
    //     is inside it; or dialogs opened near at least DIALOG_REPEATS
    //     updates and 80% of them. A cookie modal that opens once, elsewhere,
    //     is not a notice, and neither are two unrelated one-time dialogs.
    function notification(w, region, list, st, kept) {
      const nearBurst = (b, t) => t >= b.start - 100 && t <= b.end + NOTIFY_MS;
      const near = (t) => st.bursts.some((b) => nearBurst(b, t));
      let scope = region;
      for (let d = 0; d < MERGE_DEPTH && !isPageRoot(composedParent(scope)); d++) scope = composedParent(scope);

      const own = list.find((c) => regionOf(c.el));
      if (own && list.every((c) => c.live)) {
        const lr = regionOf(own.el);
        return { kind: 'live', region: lr, politeness: politenessFor(lr) };
      }

      const sorted = (arr) => arr.sort((a, b) => a - b);
      const silent = burstsOf(sorted(list.filter((c) => !c.live).map((c) => c.at)));
      const byLive = new Map(); // live region -> change times in scope
      for (const c of kept) {
        if (!c.live || !scope.contains(c.el)) continue;
        const lr = regionOf(c.el);
        if (!lr) continue;
        if (!byLive.has(lr)) byLive.set(lr, []);
        byLive.get(lr).push(c.at);
      }
      for (const [lr, times] of byLive) {
        const liveBursts = burstsOf(sorted(times));
        const hits = silent.filter((b) => times.some((t) => nearBurst(b, t))).length;
        if (hits && hits * 2 >= silent.length && Math.abs(liveBursts.length - silent.length) <= 1) {
          return { kind: 'live-beside', region: lr, politeness: politenessFor(lr) };
        }
      }

      if (w.focusins.some((f) => f.el && region.contains(f.el) && near(f.at))) return { kind: 'focus' };

      // Dialogs use no scope: "next to" can climb to a page wrapper (#root,
      // #app) that holds every dialog on the page.
      const related = w.dialogs.find((d) => near(d.at) && (d.el.contains(region) || region.contains(d.el)));
      if (related) return { kind: 'dialog', dialog: related.el };
      const repeats = st.bursts.filter((b) => w.dialogs.some((d) => nearBurst(b, d.at))).length;
      if (repeats >= DIALOG_REPEATS && repeats >= 0.8 * st.bursts.length) {
        return { kind: 'dialog', dialog: w.dialogs.find((d) => near(d.at)).el };
      }
      return null;
    }

    function report(w) {
      const { makeFinding } = F;
      const { find, describe } = globalThis.__a11yMechanism;
      const watchedMs = (w.endedAt || now()) - w.startedAt;
      let ignored = 0;
      const kept = w.changes.filter((c) => {
        const user = w.inputs.some((t) => c.at >= t && c.at - t <= INPUT_IGNORE_MS);
        if (user) ignored++;
        return !user;
      });

      // Regions that qualify; one inside another merges into the outer one.
      const groups = groupChanges(kept);
      let regions = [...groups].filter(([el, list]) => el.isConnected && rendered(el) && stats(list).qualifies);
      regions = regions.filter(([el]) => !regions.some(([outer]) => outer !== el && outer.contains(el)));
      const merged = regions.map(([el]) => [
        el,
        [...groups].filter(([inner]) => inner === el || el.contains(inner)).flatMap(([, list]) => list),
      ]);

      const findings = [];
      for (const [el, list] of merged) {
        const st = stats(list);
        const updates = updateSentence(st, watchedMs);
        const m = find(el, '2.C');
        let severity;
        let details;
        if (m && m.where !== 'elsewhere') {
          severity = 'review';
          details =
            `Content here updates automatically. ${updates} ${describe(m)} ` +
            'Activate the control and confirm that it pauses, stops, or hides the updates, or sets how often they happen (WCAG 2.2.2 / Trusted Tester 2.C).';
        } else if (m) {
          severity = 'warn';
          details =
            `Content here updates automatically. ${updates} A candidate control was found, but not where Trusted Tester 2.C expects it: ` +
            `within the first three elements, or within three elements before or after the content. ${describe(m)} ` +
            'Verify that the control pauses, stops, or hides the updates, or sets how often they happen, and that a user can find it.';
        } else {
          severity = 'warn';
          details =
            `Content here updates automatically. ${updates} No control to pause, stop, or hide it, or to set how often it updates, was found: ` +
            'no control whose name starts with pause, stop, play, hide, freeze, speed, or auto-rotate (or set, change, or toggle one of them). ' +
            'WCAG 2.2.2 (Trusted Tester 2.C) needs one unless the updates are essential. Decide whether the essential exception applies.';
        }
        findings.push(makeFinding({ tool: 'auto-update', wcag: '2.2.2', severity, el, details }));

        const n = notification(w, el, list, st, kept);
        // Inline style writes only (a script animation, a moving element, a
        // progress bar): the checker cannot tell decoration from new
        // information, so no notice is review, not fail.
        const styleOnly = list.every((c) => c.kind === 'style');
        let nDetails;
        let nSeverity = 'review';
        if (!n && styleOnly) {
          nDetails =
            `${updates} Only inline styles changed (a script animation, a moving element, or a progress bar), and the user is not told about it: no live region, no focus move, no dialog. ` +
            'If the change shows new information, such as slides that a transform moves into view, Trusted Tester 2.D needs a notice. If it is decoration only, 2.D does not apply. Check which.';
        } else if (!n) {
          nSeverity = 'fail';
          nDetails =
            `${updates} The user is not told about the updates: the content is not in a live region, focus did not move to it, and no dialog opened (Trusted Tester 2.D). ` +
            'A screen reader user does not know that it changed.';
        } else if (n.kind === 'live') {
          nDetails =
            `${updates} The updates are in a live region (${globalThis.__a11ySelector(n.region)}, ${n.politeness}), so a screen reader can announce them (Trusted Tester 2.D). ` +
            'Confirm that the announcement describes the change. A live region that announces every rotation can also disrupt reading, which is a 2.2.2 question.';
        } else if (n.kind === 'live-beside') {
          nDetails =
            `${updates} A live region in or next to this content (${globalThis.__a11ySelector(n.region)}, ${n.politeness}) changed each time it updated (Trusted Tester 2.D). ` +
            'The checker cannot tell whether it describes this change or other content. Confirm that the announcement describes this change.';
        } else if (n.kind === 'focus') {
          nDetails = `${updates} Focus moved into this content when it updated (Trusted Tester 2.D). Confirm that the content describes the change when it gets focus.`;
        } else {
          nDetails = `${updates} A dialog (${globalThis.__a11ySelector(n.dialog)}) opened when this content updated (Trusted Tester 2.D). Confirm that the dialog describes the change and that a keyboard user can reach and close it.`;
        }
        findings.push(makeFinding({ tool: 'auto-update', wcag: '4.1.2', severity: nSeverity, el, details: nDetails }));
      }

      // One page-level note, only when the run had a caveat.
      const notes = [];
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        notes.push(
          'Reduced-motion emulation was on. Some pages stop carousels and tickers under it, so this run can miss content that updates for other users. Turn Reduced motion off and run again to test the default behavior.'
        );
      }
      if (w.inputs.length) {
        notes.push(
          `User input (a key press, click, touch, or wheel scroll) happened ${w.inputs.length} time${w.inputs.length === 1 ? '' : 's'} during the watch, so ${ignored} change${ignored === 1 ? '' : 's'} in the second after it ${ignored === 1 ? 'was' : 'were'} ignored. Run again without touching the page.`
        );
      }
      if (w.scrollersCapped) {
        notes.push(
          `The page has more than ${MAX_SCROLLERS} scrolling containers. Only the first ${MAX_SCROLLERS} were watched for scroll movement, so a carousel that moves by scrolling further down the page can be missed. Check those by hand.`
        );
      }
      if (notes.length) {
        findings.push(
          makeFinding({
            tool: 'auto-update',
            wcag: '2.2.2',
            severity: 'review',
            el: null,
            details: `The checker watched the page for ${Math.round(watchedMs / 1000)} seconds. ${notes.join(' ')}`,
          })
        );
      }
      return { findings, watchedMs, regions: merged.length, inputs: w.inputs.length };
    }

    globalThis.__a11yCheckers.autoUpdate = function autoUpdate(arg) {
      const { action, seconds } = arg || {};
      switch (action) {
        case 'start': {
          const n = Math.floor(Number(seconds));
          return start(Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SECONDS) : DEFAULT_SECONDS);
        }
        case 'collect':
          if (!watch) return { missing: true };
          return watch.done.then(() => report(watch));
        case 'status':
          return { active: !!(watch && !watch.finished), seconds: watch ? watch.seconds : null };
        default:
          throw new Error(`Unknown autoUpdate action: ${action}`);
      }
    };
  })();
}
