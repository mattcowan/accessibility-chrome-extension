// Finds a user mechanism (pause / stop / hide / volume control) for
// auto-playing content and checks it against the Trusted Tester location
// rules. Injected (classic script) after selector.js, findings.js and
// accname.js; used by the motion (TT 2.B), audio (TT 2.A) and auto-update
// (TT 2.C) checkers.
//
// TT 2.A: the mechanism must be within the first three elements encountered.
// TT 2.B / 2.C: within the first three elements OR within three elements
// before/after the content.
// https://section508coordinators.github.io/TrustedTester/auto.html
//
// TT does not define "element". This helper counts in reading order — what a
// screen reader user encounters moving through the page: each control, media
// element, image with alt text, and run of text, in DOM order (open shadow
// roots included). The tab-stop position is reported alongside so a tester
// can check the count against keyboard order too.
if (!globalThis.__a11yMechanism) {
  globalThis.__a11yMechanism = (function () {
    const { collectInteractive, collectFocusables, FOCUSABLE_SELECTOR, INTERACTIVE_SELECTOR } =
      globalThis.__a11yFindings;

    const TESTS = {
      // Audio: pause/stop the audio, or control its volume.
      '2.A': {
        verbs: /\b(pause|stop|play|mute|unmute|volume|sound)\b/i,
        nearby: false,
      },
      // Moving content: pause, stop, or hide it. Muting is not a mechanism.
      '2.B': {
        verbs: /\b(pause|stop|play|hide|freeze)\b/i,
        nearby: true,
      },
      // Auto-updating content: pause, stop, or hide it, or set how often it
      // updates (a close button hides a ticker; a "speed" or "auto-rotate"
      // control sets the frequency).
      '2.C': {
        verbs: /\b(pause|stop|play|hide|freeze|close|dismiss|frequency|speed|interval|auto-?(play|refresh|update|rotate|scroll|advance))\b/i,
        nearby: true,
      },
    };

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);
    const MEDIA_TAGS = new Set(['VIDEO', 'AUDIO', 'IFRAME', 'CANVAS']);
    const ACTIVATABLE = `${INTERACTIVE_SELECTOR}, ${FOCUSABLE_SELECTOR}`;

    function hasOwnText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
      }
      return false;
    }

    function isControl(el) {
      try {
        return el.matches(ACTIVATABLE);
      } catch {
        return false;
      }
    }

    function isMediaUnit(el) {
      if (MEDIA_TAGS.has(el.tagName)) return true;
      if (el.tagName === 'IMG') return !!(el.getAttribute('alt') || '').trim();
      return el.getAttribute('role') === 'img';
    }

    // Reading-order list of encountered elements. Controls and media are
    // atomic (their insides are not separate stops); a text run counts once,
    // but controls inside it (a link in a paragraph) still count.
    function encounterOrder() {
      const out = [];
      function walk(parent, inText) {
        for (const el of parent.children) visit(el, inText);
      }
      function visit(el, inText) {
        if (SKIP_TAGS.has(el.tagName)) return;
        if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
        let style;
        try {
          style = getComputedStyle(el);
        } catch {
          return;
        }
        if (style.display === 'none') return;
        const shown = style.visibility !== 'hidden';
        if (shown && (isControl(el) || isMediaUnit(el))) {
          out.push(el);
          return;
        }
        let text = inText;
        if (shown && !inText && hasOwnText(el)) {
          out.push(el);
          text = true;
        }
        if (el.shadowRoot) walk(el.shadowRoot, text);
        walk(el, text);
      }
      if (document.body) walk(document.body, false);
      return out;
    }

    // Page snapshot shared by every find() call in one checker run, so a page
    // with many media elements walks the DOM once, not once per element.
    // Checkers call find() synchronously, so the snapshot is dropped on the
    // next task and the next run (after the page may have changed) rebuilds it.
    let snapshot = null;
    function pageSnapshot() {
      if (!snapshot) {
        snapshot = {
          order: encounterOrder(),
          tabStops: collectFocusables(document),
          interactive: collectInteractive(document),
          names: new Map(), // element -> accessible name, filled on demand
        };
        setTimeout(() => {
          snapshot = null;
        }, 0);
      }
      return snapshot;
    }

    // [lo, hi] indices the target occupies in the order list. A target that
    // is not itself a stop (a wrapper div) spans the stops inside it; an
    // empty one sits where the next stop after it would be.
    function rangeOf(target, order) {
      let lo = -1;
      let hi = -1;
      order.forEach((el, i) => {
        if (el === target || target.contains(el)) {
          if (lo === -1) lo = i;
          hi = i;
        }
      });
      if (lo !== -1) return [lo, hi];
      const next = order.findIndex(
        (el) => target.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      const at = next === -1 ? order.length : next;
      return [at, at - 1];
    }

    function nameOf(el) {
      const acc = globalThis.__a11yAccname;
      if (acc) return acc.compute(el).name;
      return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // aria-controls on `el` names the target, an element that holds it (a
    // "pause all" for a section), or an element inside it (a carousel's
    // controls name its slide track, which may be inside the changing region).
    function controlsTarget(el, target) {
      const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
      if (target.id && ids.includes(target.id)) return true;
      const root = target.getRootNode();
      return ids.some((id) => {
        const c = root.getElementById ? root.getElementById(id) : null;
        return !!c && (c === target || c.contains(target) || target.contains(c));
      });
    }

    // Best candidate mechanism for `target` under TT test `test` ('2.A' |
    // '2.B' | '2.C'), or null. `where` is 'first3' | 'near' | 'elsewhere'.
    function find(target, test) {
      const rule = TESTS[test];
      if (!rule) throw new Error(`Unknown Trusted Tester test: ${test}`);
      const { order, tabStops, interactive, names } = pageSnapshot();
      const candidates = [];
      if (target.controls) candidates.push({ el: target, name: 'native media controls', named: true });
      for (const el of interactive) {
        if (el === target) continue;
        if (!names.has(el)) names.set(el, nameOf(el));
        const name = names.get(el);
        const named = rule.verbs.test(name);
        if (named || controlsTarget(el, target)) candidates.push({ el, name, named });
      }
      if (!candidates.length) return null;

      // Best = best location, then a control whose name says what it does
      // over one that only points at the target with aria-controls (a
      // carousel's "Pause" over its "Next slide"), then the nearest.
      const [lo, hi] = rangeOf(target, order);
      const rank = { first3: 0, near: 1, elsewhere: 2 };
      const better = (a, b) =>
        rank[a.where] - rank[b.where] || Number(b.named) - Number(a.named) || a.distance - b.distance;
      let best = null;
      for (const c of candidates) {
        const index = order.indexOf(c.el);
        let where = 'elsewhere';
        if (index !== -1 && index < 3) where = 'first3';
        else if (rule.nearby && index !== -1 && index >= lo - 3 && index <= hi + 3) where = 'near';
        const distance = index === -1 ? Infinity : Math.min(Math.abs(index - lo), Math.abs(index - hi));
        const m = { ...c, index, where, distance, tabStop: tabStops.indexOf(c.el) + 1 };
        if (!best || better(m, best) < 0) best = m;
      }
      return best;
    }

    // One-sentence description of a found mechanism for finding details.
    function describe(m) {
      const sel = globalThis.__a11ySelector(m.el);
      const pos = m.index === -1 ? 'not in reading order (hidden?)' : `element ${m.index + 1} in reading order`;
      const tab = m.tabStop ? `tab stop ${m.tabStop}` : 'not a tab stop';
      const label = m.name ? `"${m.name}"` : '(no accessible name)';
      return `Candidate control ${label} at ${sel} — ${pos}, ${tab}.`;
    }

    return { find, describe, encounterOrder, TESTS };
  })();
}
