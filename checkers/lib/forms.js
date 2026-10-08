// Form-field helpers shared by Form labels (1.3.1 / TT 5.C), Error capture
// (3.3.1 / TT 5.F) and the Input watcher (3.2.2, 4.1.2 / TT 5.D, 5.E).
// Injected (classic script) after selector.js, findings.js and accname.js.
//   FIELD_SELECTOR, isField(el), collectFields(root)
//   groupMembers(el)    -> radio/checkbox inputs with the same name and form
//   groupLabel(el)      -> {text, source} from a fieldset legend or a named
//                          group/radiogroup that holds every member, or null
//   tableHeaders(el)    -> {row, col, viaHeaders, complex} for a field in a cell
//   nearbyTexts(el)     -> visible text runs around the field (its own
//                          container, or its neighbors up to the next field)
//   visibleTexts(root)  -> visible text runs under root
//   refs(el, attr)      -> elements an ID-ref attribute points at
//   textOf(node)        -> normalized textContent
if (!globalThis.__a11yForms) {
  globalThis.__a11yForms = (function () {
    const F = globalThis.__a11yFindings;
    const A = globalThis.__a11yAccname;

    const FIELD_SELECTOR = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
      'select',
      'textarea',
      '[role="textbox"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="spinbutton"]',
      '[role="searchbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="slider"]',
    ].join(', ');

    // Containers a field's "own" container never grows past.
    const STOP_TAGS = new Set(['FORM', 'FIELDSET', 'TABLE', 'BODY', 'HTML']);

    const textOf = (node) => ((node && node.textContent) || '').replace(/\s+/g, ' ').trim();

    // Elements other a11y tools put on the page are never page content.
    const isTool = (el) => !!(el.closest && el.closest('[id^="__a11y"], .__a11y-live-panel'));

    function isField(el) {
      return !!(el && el.nodeType === Node.ELEMENT_NODE && el.matches(FIELD_SELECTOR) && !isTool(el));
    }

    function collectFields(root) {
      const out = [];
      F.collectMatching(root || document, FIELD_SELECTOR, out);
      return out.filter((el) => !isTool(el));
    }

    function rendered(el) {
      if (!el || !el.isConnected) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      }
      return F.isVisible(el);
    }

    function groupMembers(el) {
      const type = (el.type || '').toLowerCase();
      if (el.tagName !== 'INPUT' || (type !== 'radio' && type !== 'checkbox') || !el.name) return [el];
      const pool = el.form ? [...el.form.elements] : [...el.getRootNode().querySelectorAll('input')];
      return pool.filter(
        (o) => o.tagName === 'INPUT' && (o.type || '').toLowerCase() === type && o.name === el.name && o.form === el.form
      );
    }

    function refs(el, attr) {
      const ids = (el.getAttribute(attr) || '').trim();
      if (!ids) return [];
      const root = el.getRootNode();
      return ids
        .split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : null))
        .filter(Boolean);
    }

    function groupLabel(el) {
      const members = groupMembers(el);
      const holdsAll = (anc) => members.every((m) => anc.contains(m));
      let node = el.parentElement;
      while (node && node !== document.body) {
        if (node.tagName === 'FIELDSET' && holdsAll(node)) {
          const legend = [...node.children].find((c) => c.tagName === 'LEGEND');
          const text = textOf(legend);
          if (text) return { text, source: 'fieldset legend' };
        }
        const role = (node.getAttribute('role') || '').toLowerCase();
        if ((role === 'group' || role === 'radiogroup') && holdsAll(node)) {
          const { name, source } = A.compute(node);
          if (name) return { text: name, source: `role="${role}" (${source})` };
        }
        node = node.parentElement;
      }
      return null;
    }

    // Grid position of each cell, so colspan and rowspan land in the right
    // column (a small version of the HTML table model).
    function tableGrid(table) {
      const grid = [];
      const pos = new Map();
      [...table.rows].forEach((row, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const cell of row.cells) {
          while (grid[r][c]) c++;
          const rs = Math.max(1, cell.rowSpan || 1);
          const cs = Math.max(1, cell.colSpan || 1);
          pos.set(cell, { r, c });
          for (let i = 0; i < rs; i++) {
            grid[r + i] = grid[r + i] || [];
            for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
          }
          c += cs;
        }
      });
      return { grid, pos };
    }

    function tableHeaders(el) {
      const cell = el.closest('td, th');
      const table = cell && cell.closest('table');
      if (!table || table.closest('[role="presentation"], [role="none"]') === table) return null;
      const viaHeaders = refs(cell, 'headers').map(textOf).filter(Boolean);
      const complex = !![...table.querySelectorAll('td[rowspan], td[colspan], th[rowspan], th[colspan]')].find(
        (c) => c.rowSpan > 1 || c.colSpan > 1
      );
      if (viaHeaders.length) return { row: [], col: [], viaHeaders, complex };
      const { grid, pos } = tableGrid(table);
      const at = pos.get(cell);
      if (!at) return null;
      const row = [];
      const col = [];
      const seen = new Set([cell]);
      for (const other of grid[at.r] || []) {
        if (!other || seen.has(other)) continue;
        seen.add(other);
        const scope = (other.getAttribute('scope') || '').toLowerCase();
        if (other.tagName === 'TH' && scope !== 'col' && scope !== 'colgroup') row.push(textOf(other));
      }
      for (let r = 0; r < grid.length; r++) {
        const other = grid[r] && grid[r][at.c];
        if (!other || seen.has(other)) continue;
        seen.add(other);
        const scope = (other.getAttribute('scope') || '').toLowerCase();
        if (other.tagName === 'TH' && scope !== 'row' && scope !== 'rowgroup') col.push(textOf(other));
      }
      return { row: row.filter(Boolean), col: col.filter(Boolean), viaHeaders: [], complex };
    }

    function visibleTexts(root) {
      const out = [];
      if (!root) return out;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(parent.tagName)) continue;
        const t = n.data.replace(/\s+/g, ' ').trim();
        if (t && !isTool(parent) && rendered(parent)) out.push(t);
      }
      return out;
    }

    // The highest ancestor that holds this field (and its radio/checkbox
    // group) and no other field. null when the parent already holds others.
    function ownContainer(el) {
      const allowed = new Set(groupMembers(el));
      allowed.add(el);
      let best = null;
      let node = el.parentElement;
      for (let depth = 0; node && depth < 5 && !STOP_TAGS.has(node.tagName); depth++) {
        const others = [...node.querySelectorAll(FIELD_SELECTOR)].some((f) => !allowed.has(f));
        if (others) break;
        best = node;
        if (node.tagName === 'TD' || node.tagName === 'TH') break;
        node = node.parentElement;
      }
      return best;
    }

    const holdsField = (n) => isField(n) || !!(n.querySelector && n.querySelector(FIELD_SELECTOR));

    function nearbyTexts(el) {
      const own = ownContainer(el);
      if (own) return visibleTexts(own);
      // No container of its own: the siblings between this field and the
      // next or previous field.
      const out = [];
      let n = el.nextElementSibling;
      for (let i = 0; n && i < 3 && !holdsField(n); i++, n = n.nextElementSibling) out.push(...visibleTexts(n));
      n = el.previousElementSibling;
      for (let i = 0; n && i < 2 && !holdsField(n); i++, n = n.previousElementSibling) out.push(...visibleTexts(n));
      return out;
    }

    return {
      FIELD_SELECTOR,
      textOf,
      isTool,
      isField,
      collectFields,
      rendered,
      groupMembers,
      refs,
      groupLabel,
      tableHeaders,
      visibleTexts,
      ownContainer,
      nearbyTexts,
    };
  })();
}
