// Tables (WCAG 1.3.1 / Trusted Tester section 14): finds every table, guesses
// whether it is a data table or a layout table, and checks its markup.
//   __a11yCheckers.tables({action, axTables, axError, overrides, selector})
//     'scan'    -> {tables: [summary], findings} (redraws the overlay if on)
//     'show'    -> the same, and draws the overlay (marker data-a11y-tables)
//     'hide'    -> removes the overlay
//     'status'  -> {active}
//     'headers' -> {headers: [{text, via}]} for the cell at `selector`, or
//                  null when it is not a table cell in this frame
// axTables: Chrome's role for each top-document table, read by the SW over
// CDP (`tableAX`): [{path, tag, role, ignored}], path = child indexes from
// the document (-1 = enter the shadow root). Frames get no Chrome role.
// overrides: the tester's classification, {`${page}|${selector}`: 'data' |
// 'layout'}; the findings use it. Without one, the tool's guess is used, and
// a result that depends on that guess is `review`, never `fail`.
// One finding per table (the fingerprint is tool|wcag|selector), with every
// issue of the table merged into it. The overlay has its own layer, so Clear
// overlays does not remove it; hide (or Clear all checkers) does.
// Needs selector.js, findings.js, resolve.js and lib/table.js.
if (!globalThis.__a11yTablesChecker) {
  globalThis.__a11yTablesChecker = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const T = globalThis.__a11yTable;
    const LAYER_ID = '__a11y-tables';
    const RANK = { fail: 3, warn: 2, review: 1 };
    const COLORS = { data: '#1d4ed8', layout: '#7e22ce', unsure: '#475569' };
    const HEADER_COLORS = { col: '#0f766e', row: '#c2410c', none: '#be185d' };
    const STRUCTURE = 'h1, h2, h3, h4, h5, h6, form, fieldset, ul, ol, dl, nav, iframe, blockquote, article, section, aside';
    const NUM_RE = /^[\s$€£¥%+\-−(),.\d]*\d[\s$€£¥%+\-−(),.\d]*$/;
    const SAMPLE_ROWS = 50;
    const MAX_HEADER_BOXES = 400;
    const MAX_LISTED = 3;

    let entries = []; // last analysis: [{table, model, summary}]
    let layer = null;
    let frame = 0; // rAF id for a pending redraw
    let listening = false;

    const isTop = window === window.top;
    const pageKey = () => location.origin + location.pathname + location.search;

    // This frame's position in the page, 1-based per level ("2", "1.3"), so
    // two frames never share a label. window.frames can be indexed and
    // compared across origins, so this works under cross-origin parents too.
    function framePath() {
      const parts = [];
      try {
        for (let w = window; w !== w.top; w = w.parent) {
          const siblings = w.parent.frames;
          let i = 0;
          while (i < siblings.length && siblings[i] !== w) i++;
          parts.unshift(i < siblings.length ? i + 1 : '?');
        }
      } catch {
        return '?';
      }
      return parts.join('.');
    }
    const quote = (s, n = 40) => `"${s.length > n ? `${s.slice(0, n - 3)}...` : s}"`;
    const at = (c) => `row ${c.y + 1}, column ${c.x + 1}`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    function rendered(el) {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    // ------------------------------------------------------------ Chrome view

    function resolvePath(path) {
      let node = document;
      for (const step of path) {
        node = step === -1 ? node.shadowRoot : node && node.children ? node.children[step] : null;
        if (!node) return null;
      }
      return node.nodeType === Node.ELEMENT_NODE ? node : null;
    }

    function chromeMap(arg) {
      const map = new Map();
      if (!isTop || !arg || !Array.isArray(arg.axTables)) return map;
      for (const t of arg.axTables) {
        const el = t && Array.isArray(t.path) ? resolvePath(t.path) : null;
        if (el && el.tagName === t.tag) map.set(el, { role: t.role, ignored: !!t.ignored });
      }
      return map;
    }

    // {status: ok|frame|error|missing|off, role, kind: data|layout|none|other}
    function chromeFor(table, map, arg) {
      if (!isTop) return { status: 'frame' };
      if (arg && arg.axError) return { status: 'error' };
      if (!arg || !Array.isArray(arg.axTables)) return { status: 'off' };
      const ax = map.get(table);
      if (!ax) return { status: 'missing' };
      const role = ax.role || '';
      let kind = 'other';
      if (ax.ignored || ['none', 'presentation', 'generic'].includes(role)) kind = 'none';
      else if (role === 'LayoutTable') kind = 'layout';
      else if (['table', 'grid', 'treegrid'].includes(role)) kind = 'data';
      return { status: 'ok', role: ax.ignored ? `${role || 'none'} (ignored)` : role, kind };
    }

    // ---------------------------------------------------------- visual signs

    const transparent = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);

    function bgOf(el, table) {
      for (let n = el; n && n !== table; n = n.parentElement) {
        const b = getComputedStyle(n).backgroundColor;
        if (!transparent(b)) return b;
      }
      return 'none';
    }

    // Bold: the cell's own weight, or the weight of the one element that
    // holds all of its text (<td><strong>Name</strong></td>).
    function looks(c, table) {
      let bold = Number(getComputedStyle(c.el).fontWeight) >= 600;
      const text = T.textOf(c.el);
      if (!bold && text && c.el.children.length === 1 && T.textOf(c.el.children[0]) === text) {
        bold = Number(getComputedStyle(c.el.children[0]).fontWeight) >= 600;
      }
      return { bold, bg: bgOf(c.el, table), text };
    }

    // Does line A (a first row or column) look like a header line, compared
    // with line B (the next one) and line C (the one after, to rule out
    // zebra stripes)?
    function headerStyled(a, b, c, table) {
      if (!a.length || !b.length) return false;
      const la = a.map((x) => looks(x, table));
      const lb = b.map((x) => looks(x, table));
      const withText = (l) => l.filter((x) => x.text);
      const allBold = (l) => withText(l).length > 0 && withText(l).every((x) => x.bold);
      if (allBold(la) && !allBold(lb)) return true;
      const uniform = (l) => l.every((x) => x.bg === l[0].bg) ? l[0].bg : null;
      const bgA = uniform(la);
      const bgB = uniform(lb);
      if (!bgA || !bgB || bgA === 'none' || bgA === bgB) return false;
      const bgC = c.length ? uniform(c.map((x) => looks(x, table))) : null;
      return bgC !== bgA;
    }

    function hasBorder(el) {
      const cs = getComputedStyle(el);
      return ['Top', 'Right', 'Bottom', 'Left'].some(
        (s) =>
          parseFloat(cs[`border${s}Width`]) > 0 &&
          !['none', 'hidden'].includes(cs[`border${s}Style`]) &&
          !transparent(cs[`border${s}Color`])
      );
    }

    function zebra(m, table) {
      if (m.rows < 5) return false;
      const bgs = [];
      for (let y = 1; y < Math.min(m.rows, 13); y++) {
        const first = m.cells.find((c) => c.y === y);
        if (!first) return false;
        bgs.push(bgOf(first.el, table));
      }
      if (new Set(bgs).size !== 2) return false;
      return bgs.every((b, i) => i < 2 || b === bgs[i - 2]) && bgs[0] !== bgs[1];
    }

    const rowCells = (m, y) => m.cells.filter((c) => c.y === y);
    const colCells = (m, x) => m.cells.filter((c) => c.x === x && c.y >= 1 && c.y < SAMPLE_ROWS);

    // ------------------------------------------------------------- the guess

    function markupOf(table, m) {
      const own = (sel) => [...table.querySelectorAll(sel)].filter((el) => T.ownerTable(el) === table);
      const headers = m.cells.filter((c) => c.header);
      const caption = table.tagName === 'TABLE' && table.caption && T.textOf(table.caption) ? table.caption : null;
      return {
        headers,
        caption,
        summary: table.tagName === 'TABLE' && (table.getAttribute('summary') || '').trim() ? table.getAttribute('summary').trim() : '',
        scoped: own('th[scope], td[scope]'),
        withHeaders: own('[headers]'),
        thead: table.tagName === 'TABLE' && table.tHead && table.tHead.rows.length > 0,
        role: T.roleOf(table),
      };
    }

    function guess(table, m, mk, chrome) {
      const data = [];
      const layout = [];
      const role = mk.role;
      if (table.tagName === 'TABLE' && (role === 'presentation' || role === 'none')) {
        layout.push(`role="${role}" on the table`);
      }
      if (table.tagName !== 'TABLE' || ['table', 'grid', 'treegrid'].includes(role)) {
        data.push(`role="${role || 'table'}"`);
      }
      const sample = m.cells.filter((c) => c.y < SAMPLE_ROWS);
      const texts = sample.map((c) => T.textOf(c.el));
      const filled = texts.filter(Boolean);
      const avg = filled.length ? filled.reduce((n, t) => n + t.length, 0) / filled.length : 0;
      let score = 0;
      const sign = (side, weight, text) => {
        (side === 'data' ? data : layout).push(text);
        score += side === 'data' ? weight : -weight;
      };
      if (mk.headers.length) sign('data', 2, plural(mk.headers.length, 'header cell', 'header cells'));
      if (mk.caption) sign('data', 2, `a caption (${quote(T.textOf(mk.caption))})`);
      if (mk.scoped.length || mk.withHeaders.length) sign('data', 1, 'scope or headers attributes');
      if (mk.thead) sign('data', 1, 'a thead');
      if (m.rows >= 2 && headerStyled(rowCells(m, 0), rowCells(m, 1), rowCells(m, 2), table)) {
        sign('data', 2, 'the first row looks like a header row (bold, or a different background)');
      }
      if (m.cols >= 2 && m.rows >= 2 && headerStyled(colCells(m, 0), colCells(m, 1), colCells(m, 2), table)) {
        sign('data', 1, 'the first column looks like a header column');
      }
      if (sample.length >= 4 && sample.filter((c) => hasBorder(c.el)).length >= sample.length / 2) {
        sign('data', 1, 'cell borders');
      }
      if (zebra(m, table)) sign('data', 1, 'alternating row colors');
      if (m.rows >= 2 && m.cols >= 2 && filled.length >= texts.length * 0.6 && avg <= 40) {
        sign('data', 1, 'rows and columns of short text');
      }
      if (filled.length >= 3 && filled.filter((t) => NUM_RE.test(t)).length >= filled.length * 0.3) {
        sign('data', 1, 'numbers in many cells');
      }
      if (sample.some((c) => c.el.querySelector('table'))) sign('layout', 2, 'a nested table');
      if (sample.some((c) => c.el.querySelector(STRUCTURE) || c.el.querySelectorAll('p').length > 1)) {
        sign('layout', 2, 'cells that hold headings, lists, forms or several paragraphs');
      }
      if (avg > 120) sign('layout', 2, 'long text in the cells');
      if (m.rows === 1) sign('layout', 2, 'one row only');
      if (m.cols === 1 && m.rows > 1) sign('layout', 1, 'one column only');
      if (chrome.kind === 'data') sign('data', 1, `Chrome exposes it as a data table (role ${chrome.role})`);
      if (chrome.kind === 'layout') sign('layout', 1, 'Chrome exposes it as a layout table (role LayoutTable)');
      if (chrome.kind === 'none') sign('layout', 1, `Chrome exposes no table (role ${chrome.role})`);

      let verdict;
      if (table.tagName === 'TABLE' && (role === 'presentation' || role === 'none')) verdict = 'layout';
      else if (table.tagName !== 'TABLE' || ['table', 'grid', 'treegrid'].includes(role)) verdict = 'data';
      else verdict = score >= 2 ? 'data' : score <= -2 ? 'layout' : 'unsure';
      return { verdict, data, layout };
    }

    // ---------------------------------------------------------------- rules

    function hasName(el) {
      if (T.textOf(el)) return true;
      if ((el.getAttribute('aria-label') || '').trim()) return true;
      if ((el.getAttribute('aria-labelledby') || '').trim()) return true;
      return !!el.querySelector('img[alt]:not([alt=""]), [aria-label]:not([aria-label=""])');
    }

    const firstText = (c) => {
      const t = T.textOf(c.el);
      return t ? ` ${quote(t)}` : '';
    };

    // Does header cell c head a non-empty data cell: one in its columns (as a
    // column header) or in its rows (as a row header)? Whole lines, as Chrome
    // assigns headers.
    function headsData(m, c) {
      const data = (d) => d && d !== c && !d.header && !T.isEmpty(d.el);
      if (c.colHeader || c.colGroupHeader) {
        for (let y = 0; y < m.rows; y++) {
          for (let x = c.x; x < c.x + c.w; x++) if (data(m.slots[y] && m.slots[y][x])) return true;
        }
      }
      if (c.rowHeader || c.rowGroupHeader) {
        for (let y = c.y; y < c.y + c.h; y++) {
          for (const d of m.slots[y] || []) if (data(d)) return true;
        }
      }
      return false;
    }

    const headsNothing = (c) => !c.colHeader && !c.rowHeader && !c.colGroupHeader && !c.rowGroupHeader;

    // Markup errors in a table that is treated as data (or not decided yet).
    function markupIssues(table, m, mk, add) {
      const emptyHeads = mk.headers.filter((c) => !hasName(c.el));
      // An empty top-left header is harmless only when it heads no data (its
      // column and row hold header cells); over td data it is an empty
      // heading like any other.
      const isCorner = (c) => c.x === 0 && c.y === 0 && !headsData(m, c);
      const corner = emptyHeads.filter(isCorner);
      const empty = emptyHeads.filter((c) => !isCorner(c));
      if (empty.length) {
        add(
          'fail',
          `${plural(empty.length, 'header cell is', 'header cells are')} empty, with no text and no accessible name (first: ${at(empty[0])}). ` +
            'A screen reader reads an empty heading for the cells under it. Add the header text, or make the cell a td if it is not a heading.'
        );
      }
      if (corner.length) {
        add(
          'review',
          'The top-left header cell is empty. It heads no data cells, so screen readers lose nothing, but a td is the better choice for an empty corner cell.'
        );
      }

      const refs = { missing: [], 'not-header': [], outside: [], self: [] };
      for (const c of m.cells) {
        if (!c.el.hasAttribute('headers')) continue;
        for (const r of T.headersOf(m, c).refs) if (r.problem) refs[r.problem].push({ c, id: r.id });
      }
      if (refs.missing.length) {
        const f = refs.missing[0];
        add(
          'fail',
          `The headers attribute of ${plural(refs.missing.length, 'cell names an id', 'cells names ids')} that does not exist (first: "${f.id}" at ${at(f.c)}). ` +
            'That cell loses the header. Fix the id, or point headers at the right th.'
        );
      }
      const odd = [...refs['not-header'], ...refs.outside, ...refs.self];
      if (odd.length) {
        const f = odd[0];
        add(
          'warn',
          `The headers attribute of ${plural(odd.length, 'cell points', 'cells point')} at something that is not a header cell of this table: a td, the cell itself, or an element outside the table (first: "${f.id}" at ${at(f.c)}). ` +
            'Check that headers names only th cells of this table.'
        );
      }

      const badScope = [...table.querySelectorAll('th[scope]')].filter(
        (el) => T.ownerTable(el) === table && !['row', 'col', 'rowgroup', 'colgroup'].includes(el.getAttribute('scope').trim().toLowerCase())
      );
      // The browser reads a scope value that is not valid as no scope, so the
      // th still heads its row or column by position: warn. Never fail: Chrome
      // gives such a th the same role as with no scope (a column-0 th is a
      // rowheader even where the spec's auto rule heads nothing; verified
      // 2026-10-15), and the "heads no row or column" review covers the spec.
      if (badScope.length) {
        add(
          'warn',
          `${plural(badScope.length, 'th has', 'th cells have')} a scope value that is not valid (first: scope="${badScope[0].getAttribute('scope')}"${firstText({ el: badScope[0] })}). ` +
            'The browser ignores it and uses the position of the cell instead. Check that the headers are still right, and use row, col, rowgroup or colgroup.'
        );
      }
      const tdScope = mk.scoped.filter((el) => el.tagName === 'TD');
      if (tdScope.length) {
        add(
          'review',
          `${plural(tdScope.length, 'td has', 'td cells have')} a scope attribute (first:${firstText({ el: tdScope[0] }) || ' an empty cell'}). ` +
            'scope works on th only. Check whether these cells are headings; if they are, make them th.'
        );
      }

      if (m.kind === 'aria') {
        if (!m.rows) {
          add('fail', `This element has role="${mk.role}" but holds no element with role="row". Screen readers cannot read it as a table.`);
        }
        if (m.orphans.length) {
          add(
            'fail',
            `${plural(m.orphans.length, 'cell', 'cells')} (role cell, gridcell, columnheader or rowheader) ${m.orphans.length === 1 ? 'is' : 'are'} not inside an element with role="row" of this table` +
              `${T.textOf(m.orphans[0]) ? ` (first: ${quote(T.textOf(m.orphans[0]))})` : ''}. Screen readers cannot place ${m.orphans.length === 1 ? 'it' : 'them'} in a row or column.`
          );
        }
      }
    }

    function dataIssues(table, m, mk, chrome, confirmed, add) {
      const guessNote = confirmed ? '' : ' The tool guessed that this is a data table; confirm it in the Tables list.';
      if (!mk.headers.length) {
        add(
          confirmed ? 'fail' : 'review',
          'It has no header cells: no th and no columnheader or rowheader role. A screen reader user hears the cell values without their row or column headings. ' +
            `WCAG 1.3.1 needs the headers of a data table in the markup: use th, with scope where needed.${guessNote}`
        );
      }
      if (m.rows >= 2 && !rowCells(m, 0).some((c) => c.header) && headerStyled(rowCells(m, 0), rowCells(m, 1), rowCells(m, 2), table)) {
        add('warn', 'The first row looks like a header row (bold text or a different background), but its cells are td, not th. Make them th if they are headings.');
      }
      if (
        m.cols >= 2 &&
        m.rows >= 2 &&
        !colCells(m, 0).some((c) => c.header) &&
        headerStyled(colCells(m, 0), colCells(m, 1), colCells(m, 2), table)
      ) {
        add('warn', 'The first column looks like a header column (bold text or a different background), but its cells are td, not th. Make them th if they are headings.');
      }

      const heads = mk.headers;
      const spanning = heads.some((c) => c.w > 1 || c.h > 1);
      const colRows = new Set(heads.filter((c) => c.colHeader).map((c) => c.y)).size;
      const rowCols = new Set(heads.filter((c) => c.rowHeader).map((c) => c.x)).size;
      const explicit = heads.some((c) => c.el.hasAttribute('scope')) || mk.withHeaders.length > 0;
      if (m.kind === 'html' && (spanning || colRows >= 2 || rowCols >= 2) && !explicit) {
        add(
          'review',
          'The headers are complex (header cells that span rows or columns, or two or more levels of headers), and no th has scope and no cell has headers. ' +
            'Screen readers can read the wrong headers for such a table. Add scope (col, row, colgroup, rowgroup) or headers and id, then check the headers of each data cell.'
        );
      }
      const lost = heads.filter((c) => headsNothing(c) && hasName(c.el));
      if (m.kind === 'html' && lost.length) {
        add(
          'review',
          `${plural(lost.length, 'header cell has', 'header cells have')} no scope, and both ${lost.length === 1 ? 'its' : 'their'} row and column hold data cells, so the markup does not say what ${lost.length === 1 ? 'it heads' : 'they head'} (first: ${at(lost[0])}${firstText(lost[0])}). ` +
            'Add scope="row" or scope="col".'
        );
      }
      if (heads.length) {
        // Whole lines count (a row header to the right of a checkbox cell
        // names it for screen readers). The line check is a quick index
        // lookup; the full algorithm runs only when it finds nothing.
        const named = (c) => T.lineHeaders(m, c).some((h) => !T.isEmpty(h.cell.el)) || T.headersOf(m, c, { wholeLine: true }).list.length > 0;
        const orphanData = m.cells.filter((c) => !c.header && !T.isEmpty(c.el) && T.textOf(c.el) && !named(c));
        if (orphanData.length) {
          const listed = orphanData.slice(0, MAX_LISTED).map((c) => `${at(c)}${firstText(c)}`).join('; ');
          add(
            'review',
            `${plural(orphanData.length, 'data cell has', 'data cells have')} no header (${listed}${orphanData.length > MAX_LISTED ? '; and more' : ''}). ` +
              'Check that these cells need no heading, or add header cells for them.'
          );
        }
      }
      if (chrome.kind === 'layout') {
        add(
          confirmed ? 'fail' : 'review',
          'Chrome exposes this table as a layout table (role LayoutTable), so screen readers can skip its table navigation and headers. ' +
            `Chrome does this for a table with no header cells, caption or other data-table signs: add th cells.${guessNote}`
        );
      } else if (chrome.kind === 'none') {
        add(
          confirmed ? 'fail' : 'review',
          `Chrome removes the table semantics of this table (role ${chrome.role}), so screen readers read it as plain content. Remove role="presentation" or role="none" from a data table.${guessNote}`
        );
      }
    }

    function layoutIssues(table, m, mk, chrome, confirmed, add) {
      const found = [];
      if (mk.headers.length) found.push(plural(mk.headers.length, 'th or header-role cell', 'th or header-role cells'));
      if (mk.caption) found.push('a caption');
      if (mk.summary) found.push('a summary attribute');
      if (mk.scoped.length) found.push('scope attributes');
      if (mk.withHeaders.length) found.push('headers attributes');
      if (['table', 'grid', 'treegrid'].includes(mk.role) || table.tagName !== 'TABLE') found.push(`role="${mk.role}"`);
      const hidden = chrome.kind === 'none' ? ' Chrome hides this markup from screen readers because of the presentation role; check if your test process still counts it.' : '';
      if (found.length) {
        add(
          confirmed ? 'fail' : 'review',
          `This layout table has data-table markup: ${found.join(', ')}. Screen readers can announce it as a data table with headings. ` +
            'WCAG 1.3.1 (TT section 14) says a layout table must not use data-table markup: change th to td and remove the caption, summary, scope and headers.' +
            hidden +
            (confirmed ? '' : ' The tool guessed that this is a layout table; confirm it in the Tables list.')
        );
      }
      if (chrome.kind === 'data') {
        const ignoredRole = ['presentation', 'none'].includes(mk.role)
          ? ` Chrome ignores role="${mk.role}" here, usually because the table has a global ARIA attribute (such as aria-label) or is focusable.`
          : '';
        add(
          'review',
          `Chrome exposes this layout table as a data table (role ${chrome.role}), so screen readers announce rows and columns.${ignoredRole} ` +
            'Add role="presentation", or remove what makes it look like data to Chrome (header cells, a caption, cell borders).'
        );
      }
    }

    // A header-only table just above a table with no headers and the same
    // number of columns: a sticky-header grid split into two tables.
    function splitPairs(list) {
      const out = new Map();
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (a.model.kind !== 'html' || b.model.kind !== 'html') continue;
        const aHeaderOnly = a.model.cells.length && a.model.cells.every((c) => c.header) && a.model.rows <= 3;
        const bNoHeaders = b.model.cells.length && !b.model.cells.some((c) => c.header);
        if (!aHeaderOnly || !bNoHeaders || a.model.cols !== b.model.cols) continue;
        const ra = a.table.getBoundingClientRect();
        const rb = b.table.getBoundingClientRect();
        if (rb.top < ra.bottom - 2 || rb.top - ra.bottom > 40) continue;
        out.set(
          b.table,
          `The header row seems to be in a different table just above this one (${globalThis.__a11ySelector(a.table)}). A screen reader does not tie those headers to these cells. Put the header row in the same table, in a thead.`
        );
        out.set(
          a.table,
          `This table holds only header cells, and the table just below it (${globalThis.__a11ySelector(b.table)}) holds the data. A screen reader does not tie these headers to that data. Put the header row in the same table as the data.`
        );
      }
      return out;
    }

    const CHECK = {
      data:
        'Data table: check that every heading you see is a header cell (colored on the page), and that the headers of each data cell match what you see. The tool checks the markup only; it cannot tell if the header text is right.',
      layout:
        'Layout table: check that it has no headings, caption or other data-table markup (the tool lists what it finds), and that its content still makes sense read from top left to bottom right.',
      unsure:
        'Decide first: if a cell only makes sense with its row or column heading, choose Data. If the table only places content on the page, choose Layout.',
    };

    function analyze(arg) {
      const overrides = (arg && arg.overrides) || {};
      const map = chromeMap(arg);
      const list = T.collect(document)
        .filter(rendered)
        .map((table) => ({ table, model: T.model(table) }))
        .filter((e) => e.model);
      const splits = splitPairs(list);
      const findings = [];
      list.forEach((e, i) => {
        const { table, model: m } = e;
        const selector = globalThis.__a11ySelector(table);
        const key = `${pageKey()}|${selector}`;
        const chrome = chromeFor(table, map, arg);
        const mk = markupOf(table, m);
        const g = guess(table, m, mk, chrome);
        const confirmed = overrides[key] === 'data' || overrides[key] === 'layout' ? overrides[key] : null;
        const cls = confirmed || g.verdict;
        const issues = [];
        const add = (severity, text) => issues.push({ severity, text });

        if (cls === 'layout') {
          layoutIssues(table, m, mk, chrome, !!confirmed, add);
        } else {
          markupIssues(table, m, mk, add);
          if (splits.has(table)) add('review', splits.get(table));
          if (cls === 'data') dataIssues(table, m, mk, chrome, !!confirmed, add);
        }
        if (cls === 'unsure') {
          add(
            'review',
            'The tool cannot tell if this is a data table or a layout table. ' +
              `Signs of data: ${g.data.join(', ') || 'none'}. Signs of layout: ${g.layout.join(', ') || 'none'}. ` +
              'If a cell only makes sense with its row or column heading, it is a data table. Choose Data or Layout in the Tables list, then run the check again (WCAG 1.3.1).'
          );
        }
        if (m.truncated) add('review', 'The table is very large; only its first part was checked.');

        const label = `${isTop ? '' : `Frame ${framePath()} `}T${i + 1}`;
        const severity = issues.reduce((s, x) => (!s || RANK[x.severity] > RANK[s] ? x.severity : s), null);
        const name =
          cls === 'unsure'
            ? 'data or layout table not decided'
            : `${cls} table (${confirmed ? 'your choice' : "the tool's guess"})`;
        if (issues.length) {
          findings.push(
            F.makeFinding({
              tool: 'tables',
              wcag: '1.3.1',
              severity,
              el: table,
              details: `${label}, ${name}: ${issues.map((x) => x.text).join(' ')}`,
            })
          );
        }
        e.summary = {
          key,
          label,
          selector,
          frame: !isTop,
          kind: m.kind,
          rows: m.rows,
          cols: m.cols,
          guess: g.verdict,
          cls,
          confirmed,
          chrome: { status: chrome.status, role: chrome.role || null },
          signals: { data: g.data, layout: g.layout },
          issues,
          severity,
          check: CHECK[cls],
        };
      });
      entries = list;
      return { tables: list.map((e) => e.summary), findings };
    }

    // --------------------------------------------------------------- overlay

    function box(rect, css) {
      const b = document.createElement('div');
      b.style.cssText =
        'position:absolute;box-sizing:border-box;pointer-events:none;' +
        `top:${rect.top + window.scrollY}px;left:${rect.left + window.scrollX}px;` +
        `width:${rect.width}px;height:${rect.height}px;${css}`;
      return b;
    }

    function draw() {
      frame = 0;
      if (!layer) return;
      if (!layer.isConnected) document.documentElement.appendChild(layer);
      layer.replaceChildren();
      let headerBoxes = 0;
      const placed = []; // label rects, so labels of adjacent tables do not cover each other
      for (const e of entries) {
        if (!e.table.isConnected || !e.summary) continue;
        const s = e.summary;
        const color = COLORS[s.cls];
        const rect = e.table.getBoundingClientRect();
        const outline = box(rect, `outline:3px solid ${color};outline-offset:2px;`);
        outline.dataset.key = s.key;
        outline.dataset.cls = s.cls;
        outline.dataset.confirmed = s.confirmed ? 'yes' : 'no';
        layer.appendChild(outline);

        for (const c of e.model.cells) {
          if (!c.header || headerBoxes >= MAX_HEADER_BOXES) continue;
          const kind = c.colHeader || c.colGroupHeader ? 'col' : c.rowHeader || c.rowGroupHeader ? 'row' : 'none';
          const hc = HEADER_COLORS[kind];
          const hb = box(
            c.el.getBoundingClientRect(),
            `background:${hc}33;outline:2px ${kind === 'none' ? 'dashed' : 'solid'} ${hc};outline-offset:-2px;`
          );
          hb.dataset.kind = kind;
          layer.appendChild(hb);
          headerBoxes++;
        }

        const tag = document.createElement('div');
        const sev = s.severity ? ` · ${s.severity}` : '';
        tag.textContent = `${s.label} ${s.cls === 'unsure' ? 'Unsure' : s.cls === 'data' ? 'Data' : 'Layout'}${s.confirmed ? ' ✓' : ''}${sev}`;
        tag.dataset.label = s.label;
        let top = Math.max(0, rect.top + window.scrollY - 22);
        let left = Math.max(0, rect.left + window.scrollX);
        // Above the table, unless that covers another table (a header-only
        // table just above, for example): then beside its top-right corner.
        const covers = entries.some((o) => {
          if (o === e || !o.table.isConnected || o.table.contains(e.table)) return false;
          const r = o.table.getBoundingClientRect();
          const y = rect.top - 22;
          return rect.left < r.right && rect.right > r.left && y < r.bottom && rect.top > r.top;
        });
        if (covers) {
          top = rect.top + window.scrollY;
          left = rect.right + window.scrollX + 6;
        }
        tag.style.cssText =
          'position:absolute;pointer-events:none;white-space:nowrap;' +
          `top:${top}px;left:${left}px;` +
          `background:${color};color:#fff;font:700 12px/18px system-ui,sans-serif;padding:1px 6px;border-radius:3px;` +
          'box-shadow:0 0 0 2px #fff;';
        layer.appendChild(tag);
        const width = tag.offsetWidth;
        const height = tag.offsetHeight;
        for (let hit = true, guard = 0; hit && guard < 50; guard++) {
          const over = placed.find((p) => left < p.right && left + width > p.left && top < p.bottom && top + height > p.top);
          hit = !!over;
          if (over) left = over.right + 6;
        }
        tag.style.left = `${left}px`;
        placed.push({ left, right: left + width, top, bottom: top + height });
      }

      const legend = document.createElement('div');
      legend.style.cssText =
        'position:fixed;left:8px;bottom:8px;pointer-events:none;background:#fff;color:#111;' +
        'font:12px/1.5 system-ui,sans-serif;padding:4px 8px;border:1px solid #555;border-radius:4px;';
      const chip = (c, text) => `<span style="display:inline-block;width:10px;height:10px;background:${c};margin:0 4px 0 8px"></span>${text}`;
      legend.innerHTML =
        '<strong>Tables</strong>' +
        chip(COLORS.data, 'data') +
        chip(COLORS.layout, 'layout') +
        chip(COLORS.unsure, 'unsure') +
        chip(HEADER_COLORS.col, 'column header') +
        chip(HEADER_COLORS.row, 'row header') +
        chip(HEADER_COLORS.none, 'header, no row or column');
      layer.appendChild(legend);
      layer.dataset.count = String(entries.length);
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(draw);
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
        // Tables inside scrolling containers move without a page scroll.
        window.addEventListener('scroll', schedule, { capture: true, passive: true });
        window.addEventListener('resize', schedule, { passive: true });
        listening = true;
      }
      document.documentElement.dataset.a11yTables = 'on';
      draw();
    }

    function hide() {
      if (listening) {
        window.removeEventListener('scroll', schedule, { capture: true });
        window.removeEventListener('resize', schedule);
        listening = false;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (layer) layer.remove();
      const stray = document.getElementById(LAYER_ID);
      if (stray) stray.remove();
      layer = null;
      delete document.documentElement.dataset.a11yTables;
    }

    const active = () => document.documentElement.dataset.a11yTables === 'on';

    function headersAt(selector) {
      if (typeof selector !== 'string' || !selector) return null;
      const el = globalThis.__a11yResolve(selector);
      const found = el && T.cellOf(el);
      if (!found || !found.cell) return null;
      const { list } = T.headersOf(found.model, found.cell);
      return { headers: list.map((h) => ({ text: T.textOf(h.cell.el), via: h.via })) };
    }

    function tables(arg) {
      const action = (arg && arg.action) || 'scan';
      if (action === 'status') return { active: active() };
      if (action === 'hide') {
        hide();
        return { active: false };
      }
      if (action === 'headers') return headersAt(arg.selector);
      const out = analyze(arg);
      if (action === 'show' || active()) show();
      return out;
    }

    globalThis.__a11yCheckers.tables = tables;
  })();
}
