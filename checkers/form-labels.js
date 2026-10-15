// Form labels (WCAG 1.3.1 / Trusted Tester 5.C): the programmatic cues a form
// field carries besides its own name.
//   __a11yCheckers.formLabels() -> findings
// 1. Radio buttons or checkboxes in one group (same name, same form) with no
//    group label: no fieldset with a legend and no named group/radiogroup
//    role. `fail`, or `review` when the question can be somewhere the checker
//    cannot judge: a member's aria-describedby, table headers on every
//    member, or a member's aria-labelledby that joins two or more elements.
// 2. Required-cue mismatch: the label or the field's own container shows "*"
//    or "required" but the field has no required / aria-required, or the
//    reverse. `review`.
// 3. Repeated names: two or more fields in one form with the same accessible
//    name. One `review` finding per set, on its first field, listing the
//    table headers or group label found for each field (TT 5.C accepts table
//    row and column associations as cues). Headers are context, not part of
//    the name.
// It only reads the DOM: it never types into, focuses or submits the form.
// Needs selector.js, findings.js, accname.js, lib/table.js and lib/forms.js.
if (!globalThis.__a11yFormLabels) {
  globalThis.__a11yFormLabels = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const A = globalThis.__a11yAccname;
    const Fo = globalThis.__a11yForms;
    const RANK = { fail: 3, warn: 2, review: 1 };
    const CUE_RE = /\*|\brequired\b/i;
    const FORM_WIDE_RE = /\ball\s+(?:fields|questions)\b[^.]*\brequired\b/i;
    const MAX_LISTED = 10;

    const quote = (s, n = 80) => `"${s.length > n ? `${s.slice(0, n - 3)}...` : s}"`;

    // display:none / visibility:hidden fields are not checked. A field hidden
    // only visually (opacity, clip), as custom radio buttons are, still is.
    function shown(el) {
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
      return F.isVisible(el);
    }

    function isRequired(members) {
      return members.some(
        (m) => m.required || (m.getAttribute('aria-required') || '').toLowerCase() === 'true'
      );
    }

    function cueText(members, label) {
      const parts = [];
      if (label) parts.push(label.text);
      for (const m of members) {
        parts.push(A.compute(m).name);
        for (const l of m.labels || []) parts.push(Fo.textOf(l));
        for (const r of Fo.refs(m, 'aria-describedby')) parts.push(Fo.textOf(r));
      }
      const own = Fo.ownContainer(members[0]);
      if (own) parts.push(...Fo.visibleTexts(own));
      return [...new Set(parts.filter(Boolean))].join(' ');
    }

    function contextOf(el) {
      const parts = [];
      const h = Fo.tableHeaders(el);
      if (h) {
        if (h.viaHeaders.length) parts.push(`headers attribute ${h.viaHeaders.map((t) => quote(t, 40)).join(', ')}`);
        if (h.row.length) parts.push(`row header ${h.row.map((t) => quote(t, 40)).join(', ')}`);
        if (h.col.length) parts.push(`column header ${h.col.map((t) => quote(t, 40)).join(', ')}`);
      }
      const type = (el.type || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox' || el.closest('fieldset, [role="group"], [role="radiogroup"]')) {
        const g = Fo.groupLabel(el);
        if (g) parts.push(`group label ${quote(g.text, 40)} (${g.source})`);
      }
      return { text: parts.join(', '), complex: !!(h && h.complex) };
    }

    function formOf(el) {
      return el.form || el.closest('form') || el.getRootNode();
    }

    function formLabels() {
      const results = new Map(); // element -> {severity, parts[]}
      const add = (el, severity, text) => {
        const cur = results.get(el) || { severity, parts: [] };
        if (RANK[severity] > RANK[cur.severity]) cur.severity = severity;
        cur.parts.push(text);
        results.set(el, cur);
      };

      const fields = Fo.collectFields(document).filter(shown);
      const done = new Set();

      for (const el of fields) {
        if (done.has(el)) continue;
        const members = Fo.groupMembers(el).filter(shown);
        if (!members.length) continue;
        for (const m of members) done.add(m);
        const first = members[0];
        const type = (first.type || '').toLowerCase();
        const grouped = members.length > 1 && (type === 'radio' || type === 'checkbox');
        const label = grouped ? Fo.groupLabel(first) : null;

        // 1. Group label.
        if (grouped && !label) {
          const kind = type === 'radio' ? 'radio buttons' : 'checkboxes';
          const options = members.slice(0, 6).map((m) => quote(A.compute(m).name || '(no name)', 30)).join(', ');
          const described = members
            .flatMap((m) => Fo.refs(m, 'aria-describedby'))
            .map(Fo.textOf)
            .filter(Boolean);
          // The question can also be in places the checker cannot judge:
          // table headers on every member (bulk-select checkboxes; TT 5.C
          // accepts table associations), or a member name built from two or
          // more elements (aria-labelledby="question option"). Those are
          // `review`, not `fail` (decided 2026-10-08 after review).
          const headers = members.map((m) => contextOf(m)).filter((c) => /header/.test(c.text));
          const inTable = headers.length === members.length;
          const joined = members.find((m) => Fo.refs(m, 'aria-labelledby').length >= 2);
          const why = [];
          if (described.length) why.push(`A member has aria-describedby (${quote(described[0])}).`);
          if (inTable) why.push(`Every member is in a table cell with headers (first: ${headers[0].text}).`);
          if (joined) why.push(`A member's aria-labelledby joins more than one element (${quote(A.compute(joined).name)}).`);
          if (why.length) {
            add(
              first,
              'review',
              `${members.length} ${kind} named "${first.name}" (${options}) have no group label: no fieldset with a legend, and no role="group" or role="radiogroup" with an accessible name. ` +
                `${why.join(' ')} Check that this gives the question these options answer; if it does not, add a fieldset and legend (WCAG 1.3.1, TT 5.C).`
            );
          } else {
            add(
              first,
              'fail',
              `${members.length} ${kind} named "${first.name}" (${options}) have no group label: no fieldset with a legend, no role="group" or role="radiogroup" with an accessible name, no aria-describedby on the members, no table headers, and no aria-labelledby that joins more than one element. ` +
                'A screen reader user hears each option but not the question. WCAG 1.3.1 (TT 5.C) needs the options tied to their question: add a fieldset and legend, or a named group role.'
            );
          }
        }

        // 2. Required cue.
        const required = isRequired(members);
        const cues = cueText(members, label);
        const cue = cues.match(CUE_RE);
        if (cue && !required) {
          add(
            first,
            'review',
            `The label or nearby text marks this field as required (${quote(cue[0])} in ${quote(cues, 60)}), but the field has no required or aria-required="true". ` +
              'A screen reader does not say "required". Add required or aria-required="true", or check that the field is optional (WCAG 1.3.1, TT 5.C).'
          );
        } else if (required && !cue && !FORM_WIDE_RE.test(Fo.textOf(formOf(first).body || formOf(first)))) {
          add(
            first,
            'review',
            'This field has required or aria-required="true", but its label and nearby text show no "*" or "required". ' +
              'Check that the page tells sighted users the field is required, for example in instructions before the form (WCAG 1.3.1 and 3.3.2, TT 5.C).'
          );
        }
      }

      // 3. Repeated names, per form.
      const byForm = new Map();
      for (const el of fields) {
        const name = A.compute(el).name.toLowerCase();
        if (!name) continue;
        const form = formOf(el);
        if (!byForm.has(form)) byForm.set(form, new Map());
        const names = byForm.get(form);
        if (!names.has(name)) names.set(name, []);
        names.get(name).push(el);
      }
      for (const names of byForm.values()) {
        for (const set of names.values()) {
          if (set.length < 2) continue;
          const ctx = set.map(contextOf);
          const counts = new Map();
          for (const c of ctx) counts.set(c.text, (counts.get(c.text) || 0) + 1);
          const apart = ctx.every((c) => c.text && counts.get(c.text) === 1);
          const lines = set.slice(0, MAX_LISTED).map(
            (el, i) => `${i + 1}) ${globalThis.__a11ySelector(el)}: ${ctx[i].text || 'no table header or group label found'}.`
          );
          if (set.length > MAX_LISTED) lines.push(`And ${set.length - MAX_LISTED} more.`);
          const name = A.compute(set[0]).name;
          let text =
            `${set.length} fields in this form have the same accessible name ${quote(name, 40)}. ` +
            `Context found for each field: ${lines.join(' ')} `;
          text += apart
            ? 'Each field has its own context. TT 5.C accepts table row and column associations as cues: check that the context tells the user which item each field belongs to (WCAG 1.3.1).'
            : 'Nothing tells some of these fields apart (same or no context). Add table headers (th), a fieldset legend, or a distinct label (WCAG 1.3.1, TT 5.C).';
          if (ctx.some((c) => c.complex)) {
            text += ' The table uses rowspan or colspan; check the headers against the HTML table header algorithm.';
          }
          add(set[0], 'review', text);
        }
      }

      const findings = [];
      for (const [el, r] of results) {
        findings.push(
          F.makeFinding({ tool: 'form-labels', wcag: '1.3.1', severity: r.severity, el, details: r.parts.join(' ') })
        );
      }
      return findings;
    }

    globalThis.__a11yCheckers.formLabels = formLabels;
  })();
}
