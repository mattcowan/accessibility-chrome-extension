// CSS positioning (WCAG 1.3.2 / Trusted Tester 15.B): finds content that CSS
// moves away from where it is in the reading order, and shows where it is.
//   __a11yCheckers.cssPosition({action})
//     'scan'      -> {items: [summary], hidden, findings} (redraws the
//                    overlay if on)
//     'show'      -> the same, and draws the overlay (marker
//                    data-a11y-css-position = on)
//     'hide'      -> removes the overlay and ends the linearize preview
//     'linearize' -> {linearized: true|false}; {on} turns the preview on/off
//     'status'    -> {active, linearized}
//
// Moved = position absolute/fixed (out of flow), position relative with a
// used offset that is not 0, or float left/right. Sticky keeps its slot in
// the flow, so it is not moved. A moved element counts only when it holds
// content a screen reader reads (text, an image with alt text, a form field,
// media); an empty decoration or a visually hidden element (sr-only clip, off
// screen) is skipped and only counted.
// Reordering container = a flex container with a -reverse direction or
// wrap-reverse, or a flex/grid container whose in-flow items use `order` or
// explicit grid placement (WCAG C27). ANDI's linearize misses these.
//
// Order check: the reading-order neighbors of each moved element are the
// nearest content before and after it in the flat tree (open shadow roots,
// slots), outside its own subtree. The element is out of order when it LOOKS
// before the content it reads after, after the content it reads before, or
// covers it. A fixed element shows wherever the window is (decided by Matt
// 2026-10-16): pinned in the top half of the window, it is compared as the
// page shows at scroll 0 (a header coded at the end of the DOM); pinned
// lower (chat, cookie bar), it gets a finding only when it holds a control,
// and is otherwise only outlined. Content in a fixed element is never a
// neighbor of other content. A reordering container compares its items with each other and
// gives ONE finding (not one per item). Every result is `review`: the tool
// sees the order, but only a person can tell if the meaning changes.
//
// Why not ANDI's linearize alone: ANDI marks an element when one of
// top/left/bottom/right is not "auto", but Chrome returns used pixel values
// for every relative/absolute/fixed element (verified 2026-10-16, Chromium
// 149), so it marks all of them, and its glow is a box-shadow on the
// element's own box, which a collapsed wrapper or an overflow:hidden
// ancestor hides. This overlay outlines the union of the element and the
// content it holds, on its own layer.
// Needs selector.js and findings.js.
if (!globalThis.__a11yCssPositionChecker) {
  globalThis.__a11yCssPositionChecker = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const TOOL = 'css-position';
    const WCAG = '1.3.2';
    const LAYER_ID = '__a11y-css-position';
    const MARK = 'data-a11y-linearize';
    const COLORS = { order: '#c2410c', ok: '#1d4ed8' };
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE']);
    const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
    const MEDIA_TAGS = new Set(['VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED']);
    const MAX_ITEMS = 20000;
    const TOL = 2; // px: rects that touch are not out of order
    const QUOTE_LEN = 40;
    const MAX_PAIRS = 3; // out-of-order item pairs named in one container finding

    let entries = []; // last scan: [{el, summary, move, reorder}]
    let hiddenEls = new Set(); // last scan: visually hidden moved elements
    let layer = null;
    let frame = 0;
    let fullNext = true; // the next draw measures every extent again
    let lastFull = 0; // performance.now() of the last full measure
    const FULL_EVERY_MS = 1000;
    let listening = false;
    let saved = null; // linearize preview: [{el, prop, value, priority}]

    const own = (el) => el && el.id && el.id.startsWith('__a11y');

    // ------------------------------------------------------------ the tree

    // Flat-tree children: a shadow host shows its shadow tree, a slot shows
    // what is assigned to it (or its fallback content).
    function childrenOf(node) {
      if (node.shadowRoot) return node.shadowRoot.childNodes;
      if (node.tagName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      return node.childNodes;
    }

    function rendered(el) {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
    }

    function textName(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    }

    // A non-text element a screen reader stops on.
    function unitName(el) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const alt = (el.getAttribute('alt') || '').trim();
        return alt ? `image “${alt}”` : null;
      }
      if (el.getAttribute('role') === 'img') return textName(el) ? `image “${textName(el)}”` : null;
      if (tag === 'svg' || tag === 'SVG') {
        const t = el.querySelector('title');
        const name = textName(el) || (t ? t.textContent.trim() : '');
        return name ? `image “${name}”` : null;
      }
      if (FIELD_TAGS.has(tag)) {
        if (tag === 'INPUT' && el.type === 'hidden') return null;
        return `${tag.toLowerCase()} field`;
      }
      if (MEDIA_TAGS.has(tag)) return tag.toLowerCase();
      return null;
    }

    function rectsOfText(node) {
      const r = document.createRange();
      r.selectNodeContents(node);
      return Array.from(r.getClientRects()).filter((x) => x.width > 0 && x.height > 0);
    }

    // The content a screen reader reads under root, in flat-tree order:
    // visit(node, rects, label) for each text run and each unit (image with
    // alt text, field, media). One walk for the scan and the overlay, so an
    // outline never covers content the scan did not compare. skipEl(el) =
    // true leaves out that subtree (the visually hidden moved elements);
    // visit returns false to stop.
    function walkContent(root, visit, skipEl) {
      let go = true;
      (function walk(parent) {
        for (const node of childrenOf(parent)) {
          if (!go) return;
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/\s+/g, ' ').trim();
            if (!text || !node.parentElement || !rendered(node.parentElement)) continue;
            const rects = rectsOfText(node);
            if (rects.length) go = visit(node, rects, `“${quote(text)}”`) !== false;
            continue;
          }
          if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName) || own(node)) continue;
          if (node.getAttribute('aria-hidden') === 'true') continue;
          if (getComputedStyle(node).display === 'none') continue;
          if (skipEl && skipEl(node)) continue;
          const unit = unitName(node);
          if (unit) {
            if (!rendered(node)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) go = visit(node, [rect], unit) !== false;
            continue; // one stop: its inside is not read separately
          }
          walk(node);
        }
      })(root);
    }

    // Content in reading order: [{node, first, last, rects, label}], where
    // first/last are the first and last line rects (viewport coordinates).
    function collectContent() {
      const items = [];
      if (document.body) {
        walkContent(document.body, (node, rects, label) => {
          items.push({ node, first: rects[0], last: rects[rects.length - 1], rects, label });
          return items.length < MAX_ITEMS;
        });
      }
      return items;
    }

    function quote(text) {
      const t = text.replace(/\s+/g, ' ').trim();
      return t.length > QUOTE_LEN ? t.slice(0, QUOTE_LEN - 1) + '…' : t;
    }

    // Flat-tree containment (a slotted node is "in" the slot's host's tree).
    function holds(ancestor, node) {
      for (let n = node; n; ) {
        if (n === ancestor) return true;
        if (n.assignedSlot) n = n.assignedSlot;
        else if (n.parentNode) n = n.parentNode;
        else n = n.host || null;
      }
      return false;
    }

    // How CSS moves the element, or null.
    function moveOf(el, cs) {
      const pos = cs.position;
      if (pos === 'absolute' || pos === 'fixed') return pos;
      if (pos === 'relative') {
        // Chrome gives used values here: "0px" when no offset is set.
        const off = ['top', 'left', 'bottom', 'right'].some((p) => {
          const v = parseFloat(cs[p]);
          return Number.isFinite(v) && Math.abs(v) >= 1;
        });
        return off ? 'relative' : null;
      }
      if (cs.float === 'left' || cs.float === 'right' || cs.float === 'inline-start' || cs.float === 'inline-end') {
        return `float: ${cs.float}`;
      }
      return null;
    }

    // How a flex or grid container can change the visual order of its
    // in-flow items, or null. Explicit grid placement is common in layouts
    // that keep code order, so this only makes the container a candidate;
    // itemPairs decides if the order really changed.
    function reorderOf(el, cs) {
      const d = cs.display;
      const flex = d === 'flex' || d === 'inline-flex';
      const grid = d === 'grid' || d === 'inline-grid';
      if (!flex && !grid) return null;
      const hows = [];
      if (flex && cs.flexDirection.endsWith('-reverse')) hows.push(`flex-direction: ${cs.flexDirection}`);
      if (flex && cs.flexWrap === 'wrap-reverse') hows.push('flex-wrap: wrap-reverse');
      let order = false;
      let placed = false;
      for (const child of childrenOf(el)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const ccs = getComputedStyle(child);
        if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
        if (ccs.order !== '0') order = true;
        if (grid && (ccs.gridRowStart !== 'auto' || ccs.gridColumnStart !== 'auto')) placed = true;
      }
      if (order) hows.push('order');
      if (placed) hows.push('grid placement');
      return hows.length ? hows.join(', ') : null;
    }

    // Visually hidden: the sr-only pattern (clip / clip-path, or a 1×1 box
    // that clips), or entirely outside the page.
    function visuallyHidden(el, cs, ext) {
      if (cs.clip && cs.clip !== 'auto') return true;
      if (/inset\(\s*50%/.test(cs.clipPath || '')) return true;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1 && cs.overflow !== 'visible') return true;
      if (!ext) return true;
      const sx = window.scrollX;
      const sy = window.scrollY;
      const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
      const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
      return ext.right + sx <= 0 || ext.bottom + sy <= 0 || ext.left + sx >= docW || ext.top + sy >= docH;
    }

    function union(rects) {
      let u = null;
      for (const r of rects) {
        if (!r || r.width <= 0 || r.height <= 0) continue;
        if (!u) u = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        else {
          u.left = Math.min(u.left, r.left);
          u.top = Math.min(u.top, r.top);
          u.right = Math.max(u.right, r.right);
          u.bottom = Math.max(u.bottom, r.bottom);
        }
      }
      if (u) {
        u.width = u.right - u.left;
        u.height = u.bottom - u.top;
      }
      return u;
    }

    // True when el or an ancestor is fixed or sticky: it moves in page
    // coordinates when the window scrolls.
    function floats(el) {
      for (let n = el; n && n.nodeType === Node.ELEMENT_NODE; ) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return true;
        n = n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
      }
      return false;
    }

    function shift(r, dx, dy) {
      return { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy, width: r.width, height: r.height };
    }

    // The first visible control inside el (or el itself), as a short label.
    function controlIn(el) {
      const list = [];
      if (el.matches(F.INTERACTIVE_SELECTOR)) list.push(el);
      F.collectMatching(el, F.INTERACTIVE_SELECTOR, list);
      // collectMatching enters the shadow roots of el's descendants, not el's
      // own (a <chat-widget> host with its button in its shadow tree).
      if (el.shadowRoot) F.collectMatching(el.shadowRoot, F.INTERACTIVE_SELECTOR, list);
      const hit = list.find((c) => F.isVisible(c));
      if (!hit) return null;
      const name = (hit.getAttribute('aria-label') || hit.textContent || hit.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
      return name ? `“${quote(name)}”` : `a ${hit.tagName.toLowerCase()}`;
    }

    // ------------------------------------------------------- visual order

    // Where b is, seen from a, in reading order: 'after' | 'before' |
    // 'overlap'. Above/below wins; on the same line, the inline direction.
    function compare(a, b, isRtl) {
      if (a.bottom <= b.top + TOL) return 'after';
      if (b.bottom <= a.top + TOL) return 'before';
      const right = b.left >= a.right - TOL;
      const left = b.right <= a.left + TOL;
      if (right) return isRtl ? 'before' : 'after';
      if (left) return isRtl ? 'after' : 'before';
      return 'overlap';
    }

    function analyze() {
      const content = collectContent();
      const list = [];
      let hidden = 0;

      // Every moved element and reordering container, in flat-tree order.
      // One element can be both (an absolute flex row-reverse).
      const moved = [];
      (function walk(parent) {
        for (const node of childrenOf(parent)) {
          if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName) || own(node)) continue;
          const cs = getComputedStyle(node);
          if (cs.display === 'none') continue;
          const move = moveOf(node, cs);
          const reorder = reorderOf(node, cs);
          if (move || reorder) moved.push({ el: node, cs, move, reorder });
          walk(node);
        }
      })(document.body || document.documentElement);

      const indexOf = new Map(content.map((c, i) => [c.node, i]));
      // Content index range inside the element (content is in flat-tree
      // order, so the element's items are one contiguous run).
      function rangeOf(el) {
        let first = -1;
        let last = -1;
        const stack = [el];
        while (stack.length) {
          const node = stack.pop();
          const i = indexOf.get(node);
          if (i !== undefined) {
            if (first < 0 || i < first) first = i;
            if (i > last) last = i;
            if (node !== el) continue;
          }
          if (node.nodeType === Node.ELEMENT_NODE) stack.push(...childrenOf(node));
        }
        return [first, last];
      }

      // Pass 1: what each moved element holds, and whether anyone sees it.
      // Content inside a visually hidden element is read but not seen, so it
      // is never a neighbor to compare with.
      // Content inside a fixed element shows wherever the window is, so it
      // is never a neighbor either.
      const unseen = new Set();
      const floating = new Set();
      const seen = [];
      hiddenEls = new Set();
      for (const m of moved) {
        const [first, last] = rangeOf(m.el);
        if (first < 0) continue; // nothing a screen reader reads
        const inside = content.slice(first, last + 1);
        const ext = union([m.el.getBoundingClientRect(), ...inside.flatMap((c) => c.rects)]);
        if (visuallyHidden(m.el, m.cs, ext)) {
          hidden++;
          hiddenEls.add(m.el);
          for (let i = first; i <= last; i++) unseen.add(i);
          continue;
        }
        if (m.move === 'fixed') for (let i = first; i <= last; i++) floating.add(i);
        Object.assign(m, { ext, first, last });
        seen.push(m);
      }

      // Pass 2: a moved element is compared with its nearest seen neighbors;
      // a reordering container compares its items with each other.
      // `seen` is in tree order, so a stack of the open entries gives each one
      // its nearest seen ancestor entry (`up`) in O(depth).
      const open = [];
      for (const m of seen) {
        while (open.length && !holds(open[open.length - 1].el, m.el)) open.pop();
        m.up = open[open.length - 1] || null;
        open.push(m);
        let fixedUp = m.up;
        while (fixedUp && fixedUp.move !== 'fixed') fixedUp = fixedUp.up;

        const inside = content.slice(m.first, m.last + 1).filter((c, k) => !unseen.has(m.first + k));
        if (!inside.length) continue;
        m.inside = inside;
        m.issues = [];
        m.pairs = m.reorder ? itemPairs(m.el, rangeOf, content, unseen) : [];
        if (m.move && fixedUp && fixedUp.pin === 'bottom') {
          // Inside a bottom-fixed element: that element is outlined, and has
          // the only finding (when it holds a control).
          list.push(m);
          continue;
        }
        if (m.move) {
          // Inside a fixed element, the content around it moves with it on
          // scroll, so compare only within that element (no scroll shift).
          // Elsewhere, content in fixed elements is never a neighbor.
          const lo = fixedUp ? fixedUp.first : 0;
          const hi = fixedUp ? fixedUp.last : content.length - 1;
          const skip = (i) => unseen.has(i) || (!fixedUp && floating.has(i));
          let p = m.first - 1;
          while (p >= lo && skip(p)) p--;
          let q = m.last + 1;
          while (q <= hi && skip(q)) q++;
          const prev = p >= lo ? content[p] : null;
          const next = q <= hi ? content[q] : null;
          // The inline direction where the element sits (a dir="rtl"
          // section can be on a left-to-right page).
          const isRtl = getComputedStyle(m.el.parentElement || m.el).direction === 'rtl';
          let start = inside[0].first;
          let end = inside[inside.length - 1].last;
          if (m.move === 'fixed' && !fixedUp) {
            const vh = window.innerHeight;
            const mid = (m.ext.top + m.ext.bottom) / 2;
            m.pin = mid < vh / 2 ? 'top' : 'bottom';
            if (m.pin === 'bottom') {
              // Bottom or side: it shows on every screen, so code order says
              // nothing about where it "is". It matters when it holds a
              // control the user has to find (chat, cookie consent).
              const control = controlIn(m.el);
              if (control) m.issues.push({ kind: 'pinned', control, other: prev });
              list.push(m);
              continue;
            }
            // Top: it shows first. Compare it as if the page were scrolled to
            // the top (its window position = its page position there).
            start = shift(start, -window.scrollX, -window.scrollY);
            end = shift(end, -window.scrollX, -window.scrollY);
          }
          if (prev) {
            const where = compare(prev.last, start, isRtl);
            if (where === 'before') m.issues.push({ kind: 'before', other: prev });
            else if (where === 'overlap') m.issues.push({ kind: 'covers', other: prev });
          }
          if (next) {
            const where = compare(end, next.first, isRtl);
            if (where === 'before') m.issues.push({ kind: 'after', other: next });
            else if (where === 'overlap') m.issues.push({ kind: 'covers', other: next });
          }
        }
        list.push(m);
      }

      // A moved element inside another moved element that has the same
      // out-of-order neighbor adds nothing: the outer one already says it.
      const findings = [];
      const summaries = [];
      for (const m of list) {
        // Against EVERY moved ancestor's unfiltered issues: with A ⊃ B ⊃ C
        // sharing one neighbor, B's copy is already filtered out, so checking
        // C against B's filtered list alone would repeat A's note.
        m.raw = m.issues.slice();
        for (let o = m.up; o; o = o.up) {
          if (!o.move || !o.raw) continue;
          m.issues = m.issues.filter((i) => !o.raw.some((oi) => oi.other === i.other));
        }
        const notes = [...m.issues.map(describe), ...m.pairs.map(describePair)];
        const how = [m.pin ? `fixed (${m.pin})` : m.move, m.reorder].filter(Boolean).join('; ');
        const summary = {
          n: summaries.length + 1,
          selector: globalThis.__a11ySelector(m.el),
          how,
          text: quote(m.inside.map((c) => (c.node.nodeType === Node.TEXT_NODE ? c.node.textContent : c.label)).join(' ')),
          order: notes.length ? 'changed' : 'same',
          notes,
        };
        summaries.push(summary);
        m.summary = summary;
        if (!notes.length) continue;
        const parts = [];
        if (m.issues.length) {
          parts.push(
            m.pin === 'bottom'
              ? `This content is positioned with CSS (fixed). ${m.issues.map(describe).join(' ')}`
              : `This content is positioned with CSS (${m.pin === 'top' ? 'fixed to the top of the window; compared as the page shows when it opens' : m.move}), ` +
                  `so where it shows is not where it is in the reading order. ${m.issues.map(describe).join(' ')}`
          );
        }
        if (m.pairs.length) {
          const shown = m.pairs.slice(0, MAX_PAIRS).map(describePair).join(' ');
          const more = m.pairs.length > MAX_PAIRS ? ` ${m.pairs.length - MAX_PAIRS} more items are out of order.` : '';
          parts.push(
            `This container changes the visual order of its items with CSS (${m.reorder}). ${shown}${more} ` +
              'Keyboard focus also follows the code order, not the visual order. ANDI\'s Linearize does not undo this; the Linearize button here does.'
          );
        }
        findings.push(
          F.makeFinding({
            tool: TOOL,
            wcag: WCAG,
            severity: 'review',
            el: m.el,
            details:
              `${parts.join(' ')} WCAG 1.3.2 (TT 15.B) requires the reading order to keep the meaning. ` +
              'Turn on Linearize and check that the content still makes sense in the order a screen reader reads it.',
          })
        );
      }
      entries = list.map((m) => ({ el: m.el, summary: m.summary, move: m.move, reorder: m.reorder, floats: floats(m.el) }));
      return { items: summaries, hidden, findings };
    }

    // The in-flow items of a reordering container, compared pairwise in code
    // order by their BOXES: two items whose boxes share a line (overlap
    // vertically: one flex line or one grid row band) are compared in the
    // inline direction by their start edges, so a tall item beside a short
    // one (align-items: center, a row-spanning grid cell) is not "above" it;
    // otherwise above/below decides. A text run directly in the container is
    // an anonymous item and counts too. The inline direction is the
    // container's own.
    function itemPairs(container, rangeOf, content, unseen) {
      const isRtl = getComputedStyle(container).direction === 'rtl';
      const items = [];
      for (const child of childrenOf(container)) {
        let box;
        if (child.nodeType === Node.TEXT_NODE) {
          box = union(rectsOfText(child));
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName)) {
          const cs = getComputedStyle(child);
          if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
          box = child.getBoundingClientRect();
        } else continue;
        if (!box || !box.width || !box.height) continue;
        const [first, last] = rangeOf(child);
        if (first < 0) continue;
        let i = first;
        while (i <= last && unseen.has(i)) i++;
        if (i > last) continue;
        items.push({ box, label: content[i].label });
      }
      const pairs = [];
      for (let k = 1; k < items.length; k++) {
        const a = items[k - 1].box;
        const b = items[k].box;
        const sameLine = a.top < b.bottom - TOL && b.top < a.bottom - TOL;
        const before = sameLine
          ? (isRtl ? b.right > a.right + TOL : b.left < a.left - TOL)
          : b.bottom <= a.top + TOL;
        if (before) pairs.push({ a: items[k - 1], b: items[k] });
      }
      return pairs;
    }

    function describe(i) {
      if (i.kind === 'pinned') {
        return (
          `It is fixed to the bottom or side of the window, so it shows on every screen, but a screen reader reaches it only ${i.other ? `after ${i.other.label}` : 'at its place in the code'}. ` +
          `It holds a control (${i.control}). Check that a screen reader user can find it, and that it does not cover content or the focused element.`
        );
      }
      if (i.kind === 'before') return `It shows before ${i.other.label}, but a screen reader reads it after.`;
      if (i.kind === 'after') return `It shows after ${i.other.label}, but a screen reader reads it before.`;
      return `It shows on top of ${i.other.label}. Check that the two make sense read one after the other.`;
    }

    function describePair(p) {
      return `${cap(p.b.label)} shows before ${p.a.label}, but a screen reader reads it after.`;
    }

    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    // ------------------------------------------------------- linearize

    // Inline !important beats every page rule, including the page's own
    // inline !important; the old inline values are kept and put back.
    // A moved element goes back into the flow (as ANDI does); a reordering
    // container drops its reverse direction, and its items their `order`
    // and grid placement (ANDI does not undo these).
    function linearize(on) {
      if (on && !saved) {
        saved = [];
        const set = (el, prop, value) => {
          saved.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
          el.style.setProperty(prop, value, 'important');
          el.setAttribute(MARK, '');
        };
        for (const e of entries) {
          if (!e.el.isConnected) continue;
          if (e.move) {
            set(e.el, 'position', 'static');
            set(e.el, 'float', 'none');
          }
          if (!e.reorder) continue;
          const cs = getComputedStyle(e.el);
          if (cs.flexDirection.endsWith('-reverse')) set(e.el, 'flex-direction', cs.flexDirection.replace('-reverse', ''));
          if (cs.flexWrap === 'wrap-reverse') set(e.el, 'flex-wrap', 'wrap');
          for (const child of childrenOf(e.el)) {
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const ccs = getComputedStyle(child);
            if (ccs.order !== '0') set(child, 'order', '0');
            // Longhands one by one: the grid-area shorthand reads '' when the
            // page set only some of them inline (style="grid-column: 2"), and
            // restoring '' to the shorthand would clear the page's own value.
            if (ccs.gridRowStart !== 'auto' || ccs.gridColumnStart !== 'auto') {
              for (const p of ['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end']) set(child, p, 'auto');
            }
          }
        }
      } else if (!on && saved) {
        // Newest first, so a property set twice ends at the page's value.
        for (const s of saved.reverse()) {
          s.el.style.setProperty(s.prop, s.value, s.priority);
          s.el.removeAttribute(MARK);
        }
        saved = null;
      }
      if (on) document.documentElement.dataset.a11yLinearize = 'on';
      else delete document.documentElement.dataset.a11yLinearize;
      schedule();
      return { linearized: !!saved };
    }

    // ------------------------------------------------------------ overlay

    function box(rect, css, sx, sy) {
      const b = document.createElement('div');
      b.style.cssText =
        'position:absolute;box-sizing:border-box;pointer-events:none;' +
        `top:${rect.top + sy}px;left:${rect.left + sx}px;` +
        `width:${Math.max(rect.width, 2)}px;height:${Math.max(rect.height, 2)}px;${css}`;
      return b;
    }

    // The extent is measured again at draw time: the page scrolls, and the
    // linearize preview moves every element. Same content rules as the scan
    // (walkContent), minus the visually hidden moved elements it skipped.
    function extentNow(e) {
      const rects = [e.el.getBoundingClientRect()];
      walkContent(e.el, (node, r) => {
        rects.push(...r);
        return rects.length < MAX_ITEMS;
      }, (el) => hiddenEls.has(el));
      return union(rects);
    }

    function draw() {
      frame = 0;
      if (!layer) return;
      if (!layer.isConnected) document.documentElement.appendChild(layer);
      layer.replaceChildren();
      // Reads first, then writes: measuring between appends would force one
      // layout per entry on every scroll frame.
      // A page scroll moves nothing in page coordinates except content in a
      // fixed or sticky element, so it reuses the last page extents; any
      // other redraw (resize, a scrolling container, linearize, a scan)
      // measures again. A page scroll also measures again when the last full
      // measure is over 1 s old, so a layout shift with no scroll or resize
      // (lazy images, late content, a fixed descendant) is stale for at most
      // that long.
      const now = performance.now();
      const full = fullNext || now - lastFull > FULL_EVERY_MS;
      fullNext = false;
      if (full) lastFull = now;
      const sx = window.scrollX;
      const sy = window.scrollY;
      const drawn = [];
      for (const e of entries) {
        if (!e.el.isConnected) continue;
        let ext;
        if (!full && !e.floats && e.pageExt !== undefined) {
          ext = e.pageExt && shift(e.pageExt, -sx, -sy);
        } else {
          ext = extentNow(e);
          e.pageExt = ext && shift(ext, sx, sy);
        }
        if (ext) drawn.push({ e, ext });
      }
      for (const d of drawn) {
        const changed = d.e.summary.order === 'changed';
        const color = changed ? COLORS.order : COLORS.ok;
        const outline = box(d.ext, `outline:3px ${changed ? 'solid' : 'dashed'} ${color};outline-offset:2px;`, sx, sy);
        outline.dataset.selector = d.e.summary.selector;
        outline.dataset.order = d.e.summary.order;
        layer.appendChild(outline);
        // A number badge (the reading order of the moved elements) to the
        // left of the outline, where it covers no content; above it when
        // there is no room on the left.
        d.tag = document.createElement('div');
        d.tag.textContent = String(d.e.summary.n);
        d.tag.style.cssText =
          'position:absolute;pointer-events:none;white-space:nowrap;text-align:center;min-width:12px;' +
          `background:${color};color:#fff;font:700 12px/16px system-ui,sans-serif;padding:1px 4px;border-radius:9px;` +
          'box-shadow:0 0 0 2px #fff;';
        layer.appendChild(d.tag);
      }
      for (const d of drawn) {
        d.w = d.tag.offsetWidth; // one layout for all badges
        d.h = d.tag.offsetHeight;
      }
      const placed = []; // badge rects, so badges never cover each other
      for (const { ext, tag, w, h } of drawn) {
        let left = ext.left + sx - w - 8;
        let top = ext.top + sy;
        if (left < 0) {
          left = Math.max(0, ext.left + sx);
          top = Math.max(0, top - h - 6);
        }
        for (let hit = true, guard = 0; hit && guard < 50; guard++) {
          const over = placed.find((p) => left < p.right && left + w > p.left && top < p.bottom && top + h > p.top);
          hit = !!over;
          if (over) top = over.bottom + 2;
        }
        tag.style.left = `${left}px`;
        tag.style.top = `${top}px`;
        placed.push({ left, right: left + w, top, bottom: top + h });
      }
      const n = drawn.length;
      const legend = document.createElement('div');
      legend.style.cssText =
        'position:fixed;left:8px;bottom:8px;pointer-events:none;background:#fff;color:#111;' +
        'font:12px/1.5 system-ui,sans-serif;padding:4px 8px;border:1px solid #555;border-radius:4px;';
      const chip = (c, style, text) =>
        `<span style="display:inline-block;width:10px;height:10px;border:2px ${style} ${c};margin:0 4px 0 8px"></span>${text}`;
      legend.innerHTML =
        `<strong>CSS positioning${saved ? ' (linearized)' : ''}</strong>` +
        chip(COLORS.order, 'solid', 'shows out of reading order') +
        chip(COLORS.ok, 'dashed', 'moved, same order') +
        '<span style="margin-left:8px">Number = reading order</span>';
      layer.appendChild(legend);
      layer.dataset.count = String(n);
    }

    function schedule() {
      fullNext = true;
      if (layer && !frame) frame = requestAnimationFrame(draw);
    }

    // The page itself scrolled (target = document): a cheap redraw. A
    // scrolling container moves the content inside it: a full one.
    function onScroll(ev) {
      if (ev.target !== document) fullNext = true;
      if (layer && !frame) frame = requestAnimationFrame(draw);
    }

    function show() {
      if (!layer) {
        layer = document.getElementById(LAYER_ID) || document.createElement('div');
        layer.id = LAYER_ID;
        layer.setAttribute('aria-hidden', 'true');
        layer.style.cssText =
          'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      }
      if (!listening) {
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('resize', schedule, { passive: true });
        listening = true;
      }
      document.documentElement.dataset.a11yCssPosition = 'on';
      fullNext = true;
      draw();
    }

    function hide() {
      linearize(false);
      if (listening) {
        window.removeEventListener('scroll', onScroll, { capture: true });
        window.removeEventListener('resize', schedule);
        listening = false;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (layer) layer.remove();
      const stray = document.getElementById(LAYER_ID);
      if (stray) stray.remove();
      layer = null;
      delete document.documentElement.dataset.a11yCssPosition;
    }

    const active = () => document.documentElement.dataset.a11yCssPosition === 'on';

    function cssPosition(arg) {
      const action = (arg && arg.action) || 'scan';
      if (action === 'status') return { active: active(), linearized: !!saved };
      if (action === 'hide') {
        hide();
        return { active: false, linearized: false };
      }
      if (action === 'linearize') {
        if (!entries.length && !saved) analyze();
        return linearize(!!(arg && arg.on));
      }
      // A scan measures the page as the author laid it out.
      const wasLinear = !!saved;
      if (wasLinear) linearize(false);
      const out = analyze();
      if (wasLinear) linearize(true);
      if (action === 'show' || active()) show();
      return out;
    }

    globalThis.__a11yCheckers.cssPosition = cssPosition;
  })();
}
