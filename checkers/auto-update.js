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
    const NOTIFY_MS = 1000; // a focus move or dialog this soon after an update notifies it
    const SCROLL_SAMPLE_MS = 200;
    const MAX_SCROLLERS = 200;
    const MERGE_DEPTH = 3; // a changed block merges into a changed ancestor this close
    const WATCHED_ATTRS = ['class', 'style', 'hidden', 'aria-hidden', 'src', 'open'];
    // Trusted input only; pointerdown covers mouse, pen and touch (one event
    // per click, so the note's count is right). Not mousemove: the tester's
    // resting pointer is no action, and hover-only changes do not repeat on
    // their own.
    const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'];
    const NOISE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
    const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';
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

    function isDialogShown(el) {
      return el.nodeType === Node.ELEMENT_NODE && el.matches(DIALOG_SELECTOR) && rendered(el);
    }

    const now = () => performance.now();

    function record(w, el, at) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return;
      if (isTool(el) || !insideBody(el)) return;
      w.changes.push({ el, at, live: !!regionOf(el) });
    }

    const textOf = (nodes) => [...nodes].map((n) => n.textContent).join('');
    const isNoise = (n) =>
      n.nodeType === Node.COMMENT_NODE ||
      (n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) ||
      (n.nodeType === Node.ELEMENT_NODE && NOISE_TAGS.has(n.tagName));

    function onMutations(w, records) {
      const at = now();
      const seen = new Set(); // one change per element per callback
      const add = (el) => {
        if (el && !seen.has(el)) {
          seen.add(el);
          record(w, el, at);
        }
      };
      for (const m of records) {
        if (m.type === 'attributes') {
          // Frameworks often re-set an attribute to the value it had.
          if (m.target.getAttribute(m.attributeName) === m.oldValue) continue;
          add(m.target);
          if (isDialogShown(m.target)) w.dialogs.push(at);
        } else if (m.type === 'characterData') {
          if (m.target.textContent === m.oldValue) continue;
          add(m.target.parentElement);
        } else {
          const added = [...m.addedNodes].filter((n) => !isNoise(n));
          const removed = [...m.removedNodes].filter((n) => !isNoise(n));
          if (!added.length && !removed.length) continue;
          // Text replaced with the same text (a re-render) is no update.
          const allText = [...added, ...removed].every((n) => n.nodeType === Node.TEXT_NODE);
          if (allText && textOf(added) === textOf(removed)) continue;
          add(m.target instanceof ShadowRoot ? m.target.host : m.target);
          for (const n of added) {
            if (n.nodeType !== Node.ELEMENT_NODE) continue;
            if (isDialogShown(n) || [...n.querySelectorAll(DIALOG_SELECTOR)].some(rendered)) w.dialogs.push(at);
          }
        }
      }
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
    // scrolls when the user scrolls).
    function scrollers() {
      const out = [];
      const all = [];
      if (!document.body) return out;
      F.collectMatching(document.body, '*', all);
      for (const el of all) {
        if (out.length >= MAX_SCROLLERS) break;
        if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
        const s = getComputedStyle(el);
        if (!/auto|scroll|hidden/.test(`${s.overflowX} ${s.overflowY}`)) continue;
        if (isTool(el)) continue;
        out.push({ el, x: el.scrollLeft, y: el.scrollTop });
      }
      return out;
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
        dialogs: [],
      };
      const observer = new MutationObserver((records) => onMutations(w, records));
      observer.observe(document.documentElement, OBSERVE);
      for (const root of shadowRoots()) observer.observe(root, OBSERVE);

      const scroll = scrollers();
      const sampler = setInterval(() => {
        const at = now();
        for (const s of scroll) {
          if (!s.el.isConnected) continue;
          if (s.el.scrollLeft !== s.x || s.el.scrollTop !== s.y) {
            s.x = s.el.scrollLeft;
            s.y = s.el.scrollTop;
            record(w, s.el, at);
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
    // slides), and a block merges into a changed ancestor at most MERGE_DEPTH
    // levels up (a slide into its track). Never up to <body>.
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
          const key = `${b.tagName}`;
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
          let a = composedParent(b);
          for (let d = 1; d <= MERGE_DEPTH && !isPageRoot(a); d++, a = composedParent(a)) {
            if (groups.has(a)) {
              merge(b, a);
              changed = true;
              break;
            }
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
    // A live region counts when the changes are inside it, or when it sits
    // near the region (inside an ancestor at most MERGE_DEPTH levels up, as a
    // carousel's "Slide 2 of 4" status beside its track) and changed with at
    // least half of the updates.
    function notification(w, region, list, st, kept) {
      const nearBurst = (b, t) => t >= b.start - 100 && t <= b.end + NOTIFY_MS;
      const near = (t) => st.bursts.some((b) => nearBurst(b, t));
      const own = list.find((c) => c.live && regionOf(c.el));
      if (own) {
        const lr = regionOf(own.el);
        return { kind: 'live', region: lr, politeness: politenessFor(lr) };
      }
      let scope = region;
      for (let d = 0; d < MERGE_DEPTH && !isPageRoot(composedParent(scope)); d++) scope = composedParent(scope);
      const beside = kept.filter((c) => c.live && scope.contains(c.el) && !region.contains(c.el) && regionOf(c.el));
      const hits = st.bursts.filter((b) => beside.some((c) => nearBurst(b, c.at))).length;
      if (hits && hits * 2 >= st.bursts.length) {
        const lr = regionOf(beside.find((c) => near(c.at)).el);
        return { kind: 'live-beside', region: lr, politeness: politenessFor(lr) };
      }
      if (w.focusins.some((f) => f.el && region.contains(f.el) && near(f.at))) return { kind: 'focus' };
      if (w.dialogs.some(near)) return { kind: 'dialog' };
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
            'no control named pause, stop, play, hide, close, or speed, and no control with aria-controls on this content. ' +
            'WCAG 2.2.2 (Trusted Tester 2.C) needs one unless the updates are essential. Decide whether the essential exception applies.';
        }
        findings.push(makeFinding({ tool: 'auto-update', wcag: '2.2.2', severity, el, details }));

        const n = notification(w, el, list, st, kept);
        let nDetails;
        if (!n) {
          nDetails =
            `${updates} The user is not told about the updates: the content is not in a live region, focus did not move to it, and no dialog opened (Trusted Tester 2.D). ` +
            'A screen reader user does not know that it changed.';
        } else if (n.kind === 'live') {
          nDetails =
            `${updates} The updates are in a live region (${globalThis.__a11ySelector(n.region)}, ${n.politeness}), so a screen reader can announce them (Trusted Tester 2.D). ` +
            'Confirm that the announcement describes the change. A live region that announces every rotation can also disrupt reading, which is a 2.2.2 question.';
        } else if (n.kind === 'live-beside') {
          nDetails =
            `${updates} A live region next to this content (${globalThis.__a11ySelector(n.region)}, ${n.politeness}) changed when it updated (Trusted Tester 2.D). ` +
            'Confirm that the announcement describes this change.';
        } else if (n.kind === 'focus') {
          nDetails = `${updates} Focus moved into this content when it updated (Trusted Tester 2.D). Confirm that the content describes the change when it gets focus.`;
        } else {
          nDetails = `${updates} A dialog opened when this content updated (Trusted Tester 2.D). Confirm that the dialog describes the change and that a keyboard user can reach and close it.`;
        }
        findings.push(makeFinding({ tool: 'auto-update', wcag: '4.1.2', severity: n ? 'review' : 'fail', el, details: nDetails }));
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
