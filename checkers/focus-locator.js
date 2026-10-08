// Focus locator (Trusted Tester 4.D vs 4.A): while the tester presses Tab by
// hand, outline the element that has focus and label it with its role, name
// and whether the PAGE shows a focus indicator there.
//   __a11yCheckers.focusLocator('start')  -> {active:true}
//   __a11yCheckers.focusLocator('stop')   -> {active:false}  (removes everything)
//   __a11yCheckers.focusLocator('status') -> {active}
// Needs selector.js, findings.js, accname.js and focus-style.js. Injected in
// the top frame only: it follows focus through open shadow roots and into
// same-origin iframes itself, and draws in top-frame coordinates.
//
// It only watches: it never calls focus()/blur() and never sends keys. The
// "no visible indicator" verdict diffs the focused element's computed style
// against a snapshot of its unfocused style (taken at start for every
// focusable, when a focusable is added to the page, and again whenever an
// element loses focus). Real Tab focus
// matches :focus-visible, so unlike the Focus visibility walker's synthetic
// focus, the computed style here is what the page really draws.
//
// The popup re-syncs its button from the documentElement marker
// data-a11y-focus-locator="on". The layer carries data-verdict / data-target
// / data-stop for E2E checks.
if (!globalThis.__a11yFocusLocator) {
  globalThis.__a11yFocusLocator = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const A = globalThis.__a11yAccname;
    const S = globalThis.__a11yFocusStyle;
    const LAYER_ID = '__a11y-focus-locator';
    const BASELINE_CAP = 2000; // focusables snapshotted per document at start
    const VERDICT_MS = 200; // re-check the indicator this often while focused
    const RESNAP_MS = 400; // after focusout, let transitions settle first
    const GAP = 4; // px between the element and the locator box
    const MAX_FRAME_DEPTH = 10;

    const PSEUDO_PROPS = [
      'content',
      'display',
      'visibility',
      'opacity',
      'backgroundColor',
      'borderBottomColor',
      'borderBottomWidth',
      'boxShadow',
      'outlineStyle',
      'transform',
      'width',
      'height',
    ];

    const COLORS = { ok: '#0f766e', warn: '#b45309', fail: '#b91c1c', info: '#475569' };

    // verdict -> [color, label text]. Every verdict on an element starts with
    // "Focus is here": focus reached it, so it is never a 4.A problem.
    const VERDICTS = {
      visible: ['ok', 'Focus is here. The page shows an outline or ring.'],
      subtle: [
        'warn',
        'Focus is here. Only the color, background or border changes. Check that the change is easy to see (TT 4.D, WCAG 2.4.7).',
      ],
      elsewhere: [
        'warn',
        'Focus is here. The change is on the parent element or a ::before/::after. Check that it is easy to see (TT 4.D, WCAG 2.4.7).',
      ],
      none: [
        'fail',
        'Focus is here, but nothing on screen changes. This is a TT 4.D failure (WCAG 2.4.7), not 4.A: the element CAN get focus.',
      ],
      hidden: [
        'fail',
        'Focus is here, but the element is hidden, has no size, or is off-screen. This is a TT 4.D failure (WCAG 2.4.7), not 4.A: the element CAN get focus.',
      ],
      mouse: [
        'warn',
        'Focus is here, but it came from a mouse click or a script. Browsers show the keyboard indicator only after a key press. Press Tab to test it.',
      ],
      unknownRing: [
        'warn',
        'Focus is here. An outline or shadow is present, but the locator has no record of this element without focus (it got focus as soon as it appeared, or it loaded later inside a frame or shadow root). Tab away and back to compare.',
      ],
      unknown: [
        'warn',
        'Focus is here. There is no outline or shadow. The locator has no record of this element without focus (it got focus as soon as it appeared, or it loaded later inside a frame or shadow root), so other changes are unknown. Tab away and back to compare.',
      ],
      frame: [
        'info',
        'Focus is inside a frame from another site. The locator cannot see inside it.',
      ],
      nofocus: ['info', 'No element has focus. Press Tab to move focus into the page.'],
    };

    let active = false;
    let rafId = 0;
    let layer = null;
    let box = null;
    let label = null;
    let docs = new Map(); // watched document -> MutationObserver (plus our focusout listener)
    let baselines = new WeakMap(); // element -> unfocused style snapshot
    let timers = new Set();
    let current = null;
    let stops = 0;
    let verdict = 'nofocus';
    let lastVerdictAt = 0;
    let drawn = {}; // style values last written to the box/label (render)

    // ------------------------------------------------------------- styles

    function snapPseudo(el, which) {
      const cs = S.styleOf(el, which);
      if (!cs.content || cs.content === 'none' || cs.content === 'normal') return { content: 'none' };
      const out = {};
      for (const p of PSEUDO_PROPS) out[p] = cs[p];
      return out;
    }

    function sameSnap(a, b) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) if (a[k] !== b[k]) return false;
      return true;
    }

    // The parent whose :focus-within style could carry the indicator. Page-wide
    // changes on <html>/<body> are not a per-element indicator.
    function parentOf(el) {
      let p = el.parentNode;
      if (p && p.nodeType === Node.DOCUMENT_FRAGMENT_NODE) p = p.host;
      if (!p || p.nodeType !== Node.ELEMENT_NODE) return null;
      if (p === el.ownerDocument.documentElement || p === el.ownerDocument.body) return null;
      return p;
    }

    function record(el) {
      try {
        const p = parentOf(el);
        baselines.set(el, {
          self: S.snap(el),
          parent: p ? S.snap(p) : null,
          before: snapPseudo(el, '::before'),
          after: snapPseudo(el, '::after'),
        });
      } catch {
        // element gone or detached — no baseline
      }
    }

    const isTransparent = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);

    function hasRing(cs) {
      const outline =
        cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && !isTransparent(cs.outlineColor);
      return outline || (!!cs.boxShadow && cs.boxShadow !== 'none');
    }

    function isHidden(el, rect, cs) {
      if (rect.width * rect.height <= 1) return true;
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
      } else if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
        return true;
      }
      const view = el.ownerDocument.defaultView;
      return (
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= view.innerWidth ||
        rect.top >= view.innerHeight
      );
    }

    function verdictFor(el) {
      const cs = S.styleOf(el);
      if (isHidden(el, el.getBoundingClientRect(), cs)) return 'hidden';
      let fv = true;
      try {
        fv = el.matches(':focus-visible');
      } catch {
        // very old engine — assume keyboard focus
      }
      if (!fv) return 'mouse';
      const base = baselines.get(el);
      if (!base) return hasRing(cs) ? 'unknownRing' : 'unknown';

      const now = S.snap(el);
      if (S.diffKind(base.self, now) === 'strong' && hasRing(cs)) return 'visible';
      // A strong diff with no visible ring (e.g. the forced-colors trick
      // `outline: 2px solid transparent`) shows nothing in normal colors, so
      // fall through to the weaker signals.
      const weak = S.SNAP_PROPS.some(
        (p) => !p.startsWith('outline') && p !== 'boxShadow' && base.self[p] !== now[p]
      );
      if (weak) return 'subtle';
      const p = parentOf(el);
      if (base.parent && p && S.diffKind(base.parent, S.snap(p)) !== 'none') return 'elsewhere';
      if (!sameSnap(base.before, snapPseudo(el, '::before'))) return 'elsewhere';
      if (!sameSnap(base.after, snapPseudo(el, '::after'))) return 'elsewhere';
      return 'none';
    }

    // ------------------------------------------------------------ tracking

    function onFocusOut(e) {
      const el = e.composedPath()[0];
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      const t = setTimeout(() => {
        timers.delete(t);
        if (active && el.isConnected && deepFocus().el !== el) record(el);
      }, RESNAP_MS);
      timers.add(t);
    }

    function recordWithin(root, cap) {
      const focused = S.deepActiveElement(root.ownerDocument || root);
      const all = [];
      if (root.matches && root.matches(F.FOCUSABLE_SELECTOR)) all.push(root);
      F.collectMatching(root, F.FOCUSABLE_SELECTOR, all);
      for (const el of all.slice(0, cap)) {
        if (el !== focused) record(el);
      }
      return all;
    }

    // Content rendered after the start (SPA views, menus) gets its baseline
    // when it is added, while it is still unfocused. An element that is
    // focused in the same task that adds it (a dialog's autofocus) still has
    // none until it loses focus once.
    function onMutations(records) {
      for (const rec of records) {
        for (const n of rec.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE || n.id === LAYER_ID) continue;
          recordWithin(n, BASELINE_CAP);
        }
      }
    }

    function watchDoc(doc) {
      if (docs.has(doc)) return;
      const observer = new MutationObserver(onMutations);
      observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
      docs.set(doc, observer);
      doc.addEventListener('focusout', onFocusOut, true);
      const all = recordWithin(doc, BASELINE_CAP);
      // Same-origin frames now, so the first element focused inside one
      // already has a baseline. Frames that load later are watched when
      // focus first enters them (deepFocus).
      for (const el of all) {
        if (el.tagName !== 'IFRAME') continue;
        try {
          if (el.contentDocument) watchDoc(el.contentDocument);
        } catch {
          // cross-origin
        }
      }
    }

    // Focused element through shadow roots and same-origin iframes, with the
    // offset of its frame's viewport in the top viewport.
    function deepFocus() {
      let doc = document;
      let offX = 0;
      let offY = 0;
      let frameEl = null;
      for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
        const el = S.deepActiveElement(doc);
        if (!el || el === doc.body || el === doc.documentElement) {
          return { el: null, frameEl, offX, offY };
        }
        if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') {
          return { el, frameEl, offX, offY };
        }
        let inner = null;
        try {
          inner = el.contentDocument;
        } catch {
          // cross-origin
        }
        if (!inner) return { el, frameEl: el, crossOrigin: true, offX, offY };
        watchDoc(inner);
        const r = el.getBoundingClientRect();
        const cs = S.styleOf(el);
        offX += r.left + el.clientLeft + parseFloat(cs.paddingLeft || '0');
        offY += r.top + el.clientTop + parseFloat(cs.paddingTop || '0');
        frameEl = el;
        doc = inner;
      }
      return { el: null, frameEl, offX, offY };
    }

    // ------------------------------------------------------------- drawing

    function make(tag, css) {
      const n = document.createElement(tag);
      n.style.cssText = 'all:initial;' + css;
      return n;
    }

    function buildLayer() {
      drawn = {};
      layer = document.createElement('div');
      layer.id = LAYER_ID;
      layer.setAttribute('aria-hidden', 'true');
      // No `display` here: when the popover API is available the layer goes
      // in the top layer (above modal dialogs) and the UA controls display.
      layer.style.cssText =
        'position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;' +
        'background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;';
      box = make(
        'div',
        'position:fixed;display:none;pointer-events:none;box-sizing:border-box;' +
          'border:3px dashed #0f766e;border-radius:3px;box-shadow:0 0 0 2px #fff,inset 0 0 0 1px #fff;'
      );
      label = make(
        'div',
        'position:fixed;display:block;pointer-events:none;max-width:360px;box-sizing:border-box;' +
          'padding:6px 9px;border-radius:5px;color:#fff;background:#0f766e;' +
          'font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;' +
          'box-shadow:0 0 0 2px #fff,0 2px 8px rgba(0,0,0,.45);'
      );
      // In the top layer the locator gets a ::backdrop, and a page rule such
      // as `::backdrop { background: rgba(0,0,0,.5) }` would dim the whole
      // page while the tester judges focus colors. Inline styles cannot reach
      // a pseudo-element; the <style> lives in the layer so it leaves with it.
      const reset = document.createElement('style');
      reset.textContent = `#${LAYER_ID}::backdrop { background: none !important; display: none !important; }`;
      layer.append(box, label, reset);
      document.documentElement.appendChild(layer);
      if (typeof layer.showPopover === 'function') layer.popover = 'manual';
      raise();
    }

    // Re-enter the top layer so the locator stays above a modal dialog the
    // page opened after it. Manual popovers do not close the page's popovers
    // and our layer holds nothing focusable, so focus is not touched.
    function raise() {
      if (!layer || layer.popover !== 'manual') return;
      try {
        if (layer.matches(':popover-open')) layer.hidePopover();
        layer.showPopover();
      } catch {
        // detached or unsupported — the fixed z-index fallback still draws
      }
    }

    function describe(target) {
      const { role, name } = A.compute(target);
      const shortName = name.length > 60 ? `${name.slice(0, 57)}...` : name;
      return `${role} ${shortName ? `"${shortName}"` : '(no name)'}`;
    }

    // render() runs every animation frame. It writes to the layer only what
    // changed: a page MutationObserver watching attributes would otherwise
    // fire 60 times a second while the locator is on.
    function setStyle(node, key, prop, value) {
      if (drawn[key] === value) return;
      drawn[key] = value;
      node.style[prop] = value;
    }

    function setData(key, value) {
      if (layer.dataset[key] !== value) layer.dataset[key] = value;
    }

    function labelText(f, target, text) {
      const lines = [];
      if (target && !f.crossOrigin) lines.push(`Stop ${stops} · ${describe(target)}`);
      else if (f.crossOrigin) lines.push(`Stop ${stops} · iframe`);
      const pageFocused = document.hasFocus();
      // "No element has focus" and "the page has no focus" say the same
      // thing twice; keep only the more useful one.
      if (pageFocused || verdict !== 'nofocus') lines.push(text);
      if (!pageFocused) {
        lines.push('This page does not have keyboard focus. Click an empty part of the page, then press Tab.');
      }
      return lines.join('\n');
    }

    // withVerdict: focus changed, or VERDICT_MS passed. The verdict, the
    // label text (accessible name) and the selector are recomputed only then;
    // other frames only follow the element's position.
    function render(f, withVerdict) {
      if (!layer || !layer.isConnected) {
        // The page removed the layer: rebuild it and redraw everything.
        layer = null;
        buildLayer();
        withVerdict = true;
      }
      const target = f.crossOrigin ? f.frameEl : f.el;
      if (withVerdict) {
        verdict = f.crossOrigin ? 'frame' : f.el ? verdictFor(f.el) : 'nofocus';
      }
      const [tone, text] = VERDICTS[verdict];
      if (withVerdict) {
        const content = labelText(f, target, text);
        if (label.textContent !== content) label.textContent = content;
        setData('verdict', verdict);
        setData('stop', String(stops));
        setData('target', target ? globalThis.__a11ySelector(target) : '');
      }
      const color = COLORS[tone];

      let rect = null;
      if (target && verdict !== 'hidden') {
        // offX/offY place the target's own document (for a cross-origin
        // frame, the document holding the <iframe>) in the top viewport.
        const r = target.getBoundingClientRect();
        rect = { left: r.left + f.offX, top: r.top + f.offY, width: r.width, height: r.height };
      }

      if (rect) {
        setStyle(box, 'boxDisplay', 'display', 'block');
        setStyle(box, 'boxColor', 'borderColor', color);
        setStyle(box, 'boxLeft', 'left', `${rect.left - GAP - 3}px`);
        setStyle(box, 'boxTop', 'top', `${rect.top - GAP - 3}px`);
        setStyle(box, 'boxWidth', 'width', `${rect.width + 2 * (GAP + 3)}px`);
        setStyle(box, 'boxHeight', 'height', `${rect.height + 2 * (GAP + 3)}px`);
      } else {
        setStyle(box, 'boxDisplay', 'display', 'none');
      }
      setStyle(label, 'labelColor', 'background', color);

      // Below the box when there is room, else above; pinned top-left when
      // there is nothing on screen to point at. With no writes above, these
      // reads cost no extra layout.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const lh = label.offsetHeight || 40;
      const lw = label.offsetWidth || 200;
      let x = 8;
      let y = 8;
      if (rect) {
        x = Math.min(Math.max(8, rect.left - GAP - 3), Math.max(8, vw - lw - 8));
        const below = rect.top + rect.height + GAP + 8;
        const above = rect.top - GAP - 8 - lh;
        y = below + lh <= vh - 4 ? below : above >= 4 ? above : Math.min(Math.max(4, below), vh - lh - 4);
      }
      setStyle(label, 'labelLeft', 'left', `${x}px`);
      setStyle(label, 'labelTop', 'top', `${y}px`);
    }

    function tick() {
      rafId = requestAnimationFrame(tick);
      try {
        const f = deepFocus();
        const focused = f.crossOrigin ? f.frameEl : f.el;
        const changed = focused !== current;
        if (changed) {
          current = focused;
          if (focused) stops++;
          raise();
        }
        const now = performance.now();
        const due = changed || now - lastVerdictAt >= VERDICT_MS;
        if (due) lastVerdictAt = now;
        render(f, due);
      } catch {
        // a frame navigated mid-read, or the element vanished — next frame retries
      }
    }

    // --------------------------------------------------------- start / stop

    function start() {
      if (active) return { active: true };
      active = true;
      watchDoc(document);
      buildLayer();
      document.documentElement.dataset.a11yFocusLocator = 'on';
      current = undefined; // force a first render
      tick();
      return { active: true };
    }

    function stop() {
      if (!active) return { active: false };
      active = false;
      cancelAnimationFrame(rafId);
      rafId = 0;
      for (const t of timers) clearTimeout(t);
      timers = new Set();
      for (const [doc, observer] of docs) {
        observer.disconnect();
        try {
          doc.removeEventListener('focusout', onFocusOut, true);
        } catch {
          // frame navigated away
        }
      }
      docs = new Map();
      baselines = new WeakMap();
      if (layer) layer.remove();
      layer = box = label = null;
      const stray = document.getElementById(LAYER_ID);
      if (stray) stray.remove();
      delete document.documentElement.dataset.a11yFocusLocator;
      current = null;
      stops = 0;
      verdict = 'nofocus';
      return { active: false };
    }

    globalThis.__a11yCheckers.focusLocator = function focusLocator(cmd) {
      if (cmd === 'start') return start();
      if (cmd === 'stop') return stop();
      return { active };
    };
  })();
}
