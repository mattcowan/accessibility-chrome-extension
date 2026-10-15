// Table model shared by Tables (1.3.1 / TT section 14) and the form tools'
// table-header context (lib/forms.js). Injected (classic script) after
// selector.js and findings.js.
//   SELECTOR, collect(root)  -> every <table> and role table/grid/treegrid
//   model(table)             -> {kind: 'html'|'aria', cells, slots, rows,
//                                cols, ...} (null for an element that is not
//                                a table)
//   headersOf(model, cell, {wholeLine})
//                            -> {list: [{cell, via}], refs: [...]} the header
//                                cells of one cell (see below); wholeLine adds
//                                every row/column header of the cell's lines
//   lineHeaders(model, cell) -> those row/column headers only
//   cellOf(el)               -> {table, model, cell} for the cell holding el
//   isEmpty(el), textOf(el)
//
// HTML tables follow the HTML table model ("forming a table") and the HTML
// "algorithm for assigning header cells" (headers attribute first; else a
// scan left along the row and up along the column, with scope row/col/
// rowgroup/colgroup), so complex tables get the same headers as the spec.
// One deliberate difference: when the spec decides whether an auto-scope th
// heads its row or its column ("no data cells in its row/column"), an EMPTY
// data cell does not count. An empty td in the top-left corner is common,
// and screen readers still read the row headers below it.
// ARIA tables (role table/grid/treegrid on a non-table element) have no
// spans: a cell's column is its index in its row, as Chrome computes it.
if (!globalThis.__a11yTable) {
  globalThis.__a11yTable = (function () {
    const F = globalThis.__a11yFindings;

    const SELECTOR = 'table, [role~="table"], [role~="grid"], [role~="treegrid"]';
    const ARIA_TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);
    const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
    // Large tables: model the first MAX_SLOTS slots only.
    const MAX_SLOTS = 20000;

    const textOf = (node) => ((node && node.textContent) || '').replace(/\s+/g, ' ').trim();

    // Elements other a11y tools put on the page are never page content.
    const isTool = (el) => !!(el.closest && el.closest('[id^="__a11y"], .__a11y-live-panel'));

    // The first token of the role attribute (ARIA's fallback roles are rare).
    function roleOf(el) {
      return ((el.getAttribute && el.getAttribute('role')) || '').trim().toLowerCase().split(/\s+/)[0];
    }

    function collect(root) {
      const out = [];
      F.collectMatching(root || document, SELECTOR, out);
      return out.filter((el) => !isTool(el) && (el.tagName === 'TABLE' || ARIA_TABLE_ROLES.has(roleOf(el))));
    }

    // The spec's "empty cell": no elements, and only white space as text.
    function isEmpty(el) {
      return !el.firstElementChild && !textOf(el);
    }

    const clampSpan = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : 1));

    // A cell's own role: an explicit cell role wins (a td with
    // role="columnheader" is a header in Chrome), else the tag.
    function isHeaderEl(el) {
      const role = roleOf(el);
      if (role === 'columnheader' || role === 'rowheader') return true;
      if (role === 'cell' || role === 'gridcell') return false;
      return el.tagName === 'TH';
    }

    // scope applies to th only: row | col | rowgroup | colgroup | auto.
    // An explicit header role acts as row / col.
    function scopeOf(el) {
      const role = roleOf(el);
      if (role === 'columnheader') return 'col';
      if (role === 'rowheader') return 'row';
      if (el.tagName !== 'TH') return 'auto';
      const s = (el.getAttribute('scope') || '').trim().toLowerCase();
      return ['row', 'col', 'rowgroup', 'colgroup'].includes(s) ? s : 'auto';
    }

    // ------------------------------------------------------------ HTML tables

    function htmlModel(table) {
      const cells = [];
      const slots = [];
      const rowGroups = [];
      const colGroups = [];
      let truncated = false;

      let cx = 0;
      for (const child of table.children) {
        if (child.tagName !== 'COLGROUP') continue;
        const cols = [...child.children].filter((c) => c.tagName === 'COL');
        const span = cols.length
          ? cols.reduce((n, c) => n + clampSpan(c.span, 1, 1000), 0)
          : clampSpan(child.span, 1, 1000);
        colGroups.push({ el: child, start: cx, end: cx + span });
        cx += span;
      }

      // Row groups in tree order; tfoot goes last, as the spec says. A run of
      // tr children directly in the table (only scripts make these; the
      // parser adds a tbody) counts as one group.
      const groups = [];
      const feet = [];
      let loose = null;
      for (const child of table.children) {
        if (child.tagName === 'TR') {
          if (!loose) groups.push((loose = { el: null, rows: [] }));
          loose.rows.push(child);
          continue;
        }
        loose = null;
        if (child.tagName === 'THEAD' || child.tagName === 'TBODY') {
          groups.push({ el: child, rows: [...child.children].filter((r) => r.tagName === 'TR') });
        } else if (child.tagName === 'TFOOT') {
          feet.push({ el: child, rows: [...child.children].filter((r) => r.tagName === 'TR') });
        }
      }
      groups.push(...feet);

      let y = 0;
      let used = 0;
      for (const g of groups) {
        const start = y;
        const end = start + g.rows.length;
        for (const tr of g.rows) {
          slots[y] = slots[y] || [];
          let x = 0;
          for (const el of tr.children) {
            if (el.tagName !== 'TD' && el.tagName !== 'TH') continue;
            while (slots[y][x]) x++;
            const w = clampSpan(el.colSpan, 1, 1000);
            const rs = el.rowSpan === 0 ? end - y : clampSpan(el.rowSpan, 1, 65534);
            const h = Math.max(1, Math.min(rs, end - y));
            used += w * h;
            if (used > MAX_SLOTS) {
              truncated = true;
              break;
            }
            const cell = { el, x, y, w, h, header: isHeaderEl(el), scope: scopeOf(el), rowGroup: rowGroups.length };
            cells.push(cell);
            for (let i = 0; i < h; i++) {
              slots[y + i] = slots[y + i] || [];
              for (let j = 0; j < w; j++) if (!slots[y + i][x + j]) slots[y + i][x + j] = cell;
            }
            x += w;
          }
          if (truncated) break;
          y++;
        }
        rowGroups.push({ el: g.el, start, end: y });
        if (truncated) break;
      }
      const rows = slots.length;
      const cols = slots.reduce((n, r) => Math.max(n, r ? r.length : 0), 0);
      const model = { kind: 'html', table, cells, slots, rows, cols, rowGroups, colGroups, truncated };
      classifyHeaders(model);
      return indexModel(model);
    }

    // Lookups built once per model, so per-cell header queries stay linear in
    // the table size: element -> cell, the row headers covering each row, the
    // column headers covering each column, and the row/column group headers.
    function indexModel(model) {
      model.byEl = new Map(model.cells.map((c) => [c.el, c]));
      model.rowHeadsAt = [];
      model.colHeadsAt = [];
      model.rowGroupHeads = new Map();
      model.colGroupHeads = new Map();
      const push = (map, key, c) => (map.get(key) || map.set(key, []).get(key)).push(c);
      for (const c of model.cells) {
        if (!c.header) continue;
        if (c.rowHeader) for (let y = c.y; y < c.y + c.h; y++) (model.rowHeadsAt[y] = model.rowHeadsAt[y] || []).push(c);
        if (c.colHeader) for (let x = c.x; x < c.x + c.w; x++) (model.colHeadsAt[x] = model.colHeadsAt[x] || []).push(c);
        if (c.rowGroupHeader) push(model.rowGroupHeads, c.rowGroup, c);
        if (c.colGroupHeader && c.colGroup !== -1) push(model.colGroupHeads, c.colGroup, c);
      }
      return model;
    }

    // Every row header in the cell's rows and every column header in its
    // columns, at any position. Chrome gives screen readers a cell's headers
    // this way (all rowheader cells of the row, all columnheader cells of the
    // column), so a row header to the RIGHT of a checkbox cell still names
    // it, which the spec's leftward scan misses.
    function lineHeaders(model, cell) {
      const out = [];
      for (let y = cell.y; y < cell.y + cell.h; y++) {
        for (const c of model.rowHeadsAt[y] || []) if (c !== cell) out.push({ cell: c, via: 'row' });
      }
      for (let x = cell.x; x < cell.x + cell.w; x++) {
        for (const c of model.colHeadsAt[x] || []) if (c !== cell) out.push({ cell: c, via: 'col' });
      }
      return out;
    }

    // Column / row header per the spec, with empty data cells not counted
    // (see the file comment).
    function classifyHeaders(model) {
      const { slots, cells, rows, cols } = model;
      const dataInRows = (y0, h) => {
        for (let y = y0; y < y0 + h && y < rows; y++) {
          for (const c of slots[y] || []) if (c && !c.header && !isEmpty(c.el)) return true;
        }
        return false;
      };
      const dataInCols = (x0, w) => {
        for (let y = 0; y < rows; y++) {
          for (let x = x0; x < x0 + w && x < cols; x++) {
            const c = slots[y] && slots[y][x];
            if (c && !c.header && !isEmpty(c.el)) return true;
          }
        }
        return false;
      };
      for (const c of cells) {
        c.colHeader = c.header && (c.scope === 'col' || (c.scope === 'auto' && !dataInRows(c.y, c.h)));
        c.rowHeader =
          c.header && !c.colHeader && (c.scope === 'row' || (c.scope === 'auto' && !dataInCols(c.x, c.w)));
        c.colGroupHeader = c.header && c.scope === 'colgroup';
        c.rowGroupHeader = c.header && c.scope === 'rowgroup';
        c.colGroup = model.colGroups.findIndex((g) => c.x >= g.start && c.x < g.end);
      }
    }

    // The spec's "internal algorithm for scanning and assigning header cells".
    function scan(model, principal, x0, y0, dx, dy, out) {
      const opaque = [];
      let inBlock = principal.header;
      let block = principal.header ? [principal] : [];
      let x = x0;
      let y = y0;
      for (;;) {
        x += dx;
        y += dy;
        if (x < 0 || y < 0) return;
        const cur = model.slots[y] && model.slots[y][x];
        if (!cur) continue;
        if (cur.header) {
          inBlock = true;
          block.push(cur);
          let blocked = false;
          if (dx === 0) {
            if (opaque.some((o) => o.x === cur.x && o.w === cur.w) || !cur.colHeader) blocked = true;
          } else if (opaque.some((o) => o.y === cur.y && o.h === cur.h) || !cur.rowHeader) {
            blocked = true;
          }
          if (!blocked) out.push({ cell: cur, via: dx === 0 ? 'col' : 'row' });
        } else if (inBlock) {
          inBlock = false;
          opaque.push(...block);
          block = [];
        }
      }
    }

    // refs: the headers attribute's tokens, each {id, cell|null, problem}
    // (problem: 'missing' | 'outside' | 'self' | 'not-header' | null).
    function htmlHeaders(model, cell) {
      const list = [];
      const refs = [];
      const attr = cell.el.getAttribute('headers');
      if (attr !== null && attr.trim()) {
        const root = cell.el.getRootNode();
        for (const id of attr.trim().split(/\s+/)) {
          const target = root.getElementById ? root.getElementById(id) : null;
          const hit = target && model.byEl.get(target);
          let problem = null;
          if (!target) problem = 'missing';
          else if (!hit) problem = 'outside';
          else if (hit === cell) problem = 'self';
          else if (!hit.header) problem = 'not-header';
          refs.push({ id, cell: hit || null, problem });
          if (hit && hit !== cell) list.push({ cell: hit, via: 'headers' });
        }
      } else {
        for (let y = cell.y; y < cell.y + cell.h; y++) scan(model, cell, cell.x, y, -1, 0, list);
        for (let x = cell.x; x < cell.x + cell.w; x++) scan(model, cell, x, cell.y, 0, -1, list);
        const right = cell.x + cell.w - 1;
        const bottom = cell.y + cell.h - 1;
        const inReach = (c) => c !== cell && c.x <= right && c.y <= bottom;
        for (const c of model.rowGroupHeads.get(cell.rowGroup) || []) {
          if (inReach(c)) list.push({ cell: c, via: 'rowgroup' });
        }
        if (cell.colGroup !== -1) {
          for (const c of model.colGroupHeads.get(cell.colGroup) || []) {
            if (inReach(c)) list.push({ cell: c, via: 'colgroup' });
          }
        }
      }
      const seen = new Set();
      return {
        list: list.filter((h) => !isEmpty(h.cell.el) && h.cell !== cell && !seen.has(h.cell) && seen.add(h.cell)),
        refs,
      };
    }

    // ------------------------------------------------------------ ARIA tables

    // The element's nearest table, native or ARIA.
    function ownerTable(el) {
      let n = el.parentElement || (el.parentNode && el.parentNode.host);
      while (n) {
        if (n.tagName === 'TABLE' || ARIA_TABLE_ROLES.has(roleOf(n))) return n;
        n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
      }
      return null;
    }

    function nearestRow(el, table) {
      let n = el.parentElement;
      while (n && n !== table) {
        if (roleOf(n) === 'row') return n;
        n = n.parentElement;
      }
      return null;
    }

    function ariaModel(table) {
      const all = [...table.querySelectorAll('[role]')].filter((el) => ownerTable(el) === table);
      const rowEls = all.filter((el) => roleOf(el) === 'row');
      const cellEls = all.filter((el) => CELL_ROLES.has(roleOf(el)));
      const cells = [];
      const slots = [];
      const orphans = [];
      const rowIndex = new Map(rowEls.map((r, i) => [r, i]));
      for (const el of cellEls) {
        const row = nearestRow(el, table);
        if (!row || !rowIndex.has(row)) {
          orphans.push(el);
          continue;
        }
        const y = rowIndex.get(row);
        slots[y] = slots[y] || [];
        const x = slots[y].length;
        const role = roleOf(el);
        const cell = {
          el,
          x,
          y,
          w: 1,
          h: 1,
          header: role === 'columnheader' || role === 'rowheader',
          scope: role === 'columnheader' ? 'col' : role === 'rowheader' ? 'row' : 'auto',
          rowGroup: 0,
          colGroup: -1,
        };
        cell.colHeader = role === 'columnheader';
        cell.rowHeader = role === 'rowheader';
        cell.colGroupHeader = cell.rowGroupHeader = false;
        cells.push(cell);
        slots[y][x] = cell;
      }
      for (let y = 0; y < rowEls.length; y++) slots[y] = slots[y] || [];
      const cols = slots.reduce((n, r) => Math.max(n, r.length), 0);
      const emptyRows = rowEls.filter((r, i) => !slots[i].length);
      return indexModel({
        kind: 'aria',
        table,
        cells,
        slots,
        rows: rowEls.length,
        cols,
        rowGroups: [],
        colGroups: [],
        rowEls,
        orphans,
        emptyRows,
        truncated: false,
      });
    }

    // An ARIA table's headers are its line headers, as Chrome computes them.
    function ariaHeaders(model, cell) {
      return { list: lineHeaders(model, cell).filter((h) => textOf(h.cell.el)), refs: [] };
    }

    // ---------------------------------------------------------------- public

    function model(table) {
      if (!table) return null;
      if (table.tagName === 'TABLE') return htmlModel(table);
      return ARIA_TABLE_ROLES.has(roleOf(table)) ? ariaModel(table) : null;
    }

    // opts.wholeLine: also every non-empty row header of the cell's rows and
    // column header of its columns (what Chrome gives screen readers), when
    // the cell has no headers attribute. Use it to ask "does this cell have a
    // header at all"; without it the result is the spec algorithm's.
    function headersOf(m, cell, opts = {}) {
      const out = m.kind === 'html' ? htmlHeaders(m, cell) : ariaHeaders(m, cell);
      if (!opts.wholeLine || out.refs.length) return out;
      const seen = new Set(out.list.map((h) => h.cell));
      for (const h of lineHeaders(m, cell)) {
        if (!seen.has(h.cell) && !isEmpty(h.cell.el)) {
          seen.add(h.cell);
          out.list.push(h);
        }
      }
      return out;
    }

    // The cell (td/th or ARIA cell) that holds el, with its table's model.
    function cellOf(el) {
      const cellEl = el.closest('td, th, [role~="cell"], [role~="gridcell"], [role~="columnheader"], [role~="rowheader"]');
      if (!cellEl) return null;
      const table = cellEl.tagName === 'TD' || cellEl.tagName === 'TH' ? cellEl.closest('table') : ownerTable(cellEl);
      const m = model(table);
      const cell = m && m.cells.find((c) => c.el === cellEl);
      return cell ? { table, model: m, cell } : null;
    }

    return { SELECTOR, collect, model, headersOf, lineHeaders, cellOf, isEmpty, textOf, roleOf, isTool, ownerTable };
  })();
}
