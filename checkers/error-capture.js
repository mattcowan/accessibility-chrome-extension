// Error capture (WCAG 3.3.1 / Trusted Tester 5.F; the quoted text lets the
// tester judge 3.3.3 / TT 5.G): records what each form field shows after the
// tester submits bad data.
//   __a11yCheckers.errorCapture('start')   -> {active:true, fields}
//   __a11yCheckers.errorCapture('stop')    -> {active:false}  (removes everything)
//   __a11yCheckers.errorCapture('status')  -> {active, captures}
//   __a11yCheckers.errorCapture('collect') -> findings (one per field that
//       showed an error, wcag 3.3.1: `warn` when the error is shown only by a
//       color change with no text, else `review`)
// Needs selector.js, findings.js, accname.js, lib/forms.js, focus-style.js and
// lib/live.js. Top frame only.
//
// It only watches: the tester types and submits; the capture never types,
// clicks or submits. At start it records each field (aria-invalid, the text
// its aria-describedby / aria-errormessage targets show, visible text around
// it, error-summary links to it, and its colors). A click on a button, Enter
// in a field, a submit or an `invalid` event opens a capture window; when the
// DOM has been quiet for QUIET_MS (MIN_MS..MAX_MS) each field is compared
// with its start state. Live-region changes and focus moves inside the window
// are the announcement cues. After each window the page posts
// {type:'errorCaptureUpdate', findings} so an open popup or side panel can
// store them; a popup opened later reads them with 'collect'.
//
// The documentElement carries data-a11y-error-capture="on" (popup re-sync)
// and data-a11y-error-captures="<n>" (completed windows, for E2E).
if (!globalThis.__a11yErrorCapture) {
  globalThis.__a11yErrorCapture = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const A = globalThis.__a11yAccname;
    const Fo = globalThis.__a11yForms;
    const S = globalThis.__a11yFocusStyle;
    const L = globalThis.__a11yLive;
    const QUIET_MS = 700;
    const MIN_MS = 1000;
    const MAX_MS = 4000;
    const TICK_MS = 100;
    const FIELD_CAP = 1000;
    const TRIGGER_SELECTOR =
      'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]';
    const REBASE_MS = 400; // after focusout, let focus transitions settle first
    const PROP_NAMES = {
      outlineStyle: 'outline',
      outlineWidth: 'outline',
      outlineColor: 'outline',
      boxShadow: 'shadow',
      backgroundColor: 'background color',
      color: 'text color',
      borderTopColor: 'border color',
      borderRightColor: 'border color',
      borderBottomColor: 'border color',
      borderLeftColor: 'border color',
      textDecorationLine: 'underline',
    };

    let active = false;
    let baselines = new Map(); // field -> snapshot at start (or when first seen)
    let results = new Map(); // field -> finding (latest window that changed it)
    let win = null; // open capture window
    let observer = null;
    let captures = 0;
    let timers = new Set();

    const quote = (s, n = 120) => `"${s.length > n ? `${s.slice(0, n - 3)}...` : s}"`;
    const shown = (el) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : F.isVisible(el);

    // ------------------------------------------------------------ snapshots

    function tied(el, invalid) {
      const out = [];
      for (const r of Fo.refs(el, 'aria-describedby')) {
        const t = Fo.textOf(r);
        if (t && shown(r)) out.push({ text: t, how: 'tied by aria-describedby', node: r });
      }
      // aria-errormessage counts only while aria-invalid is true (WAI-ARIA 1.2).
      if (invalid === 'true') {
        for (const r of Fo.refs(el, 'aria-errormessage')) {
          const t = Fo.textOf(r);
          if (t && shown(r)) out.push({ text: t, how: 'tied by aria-errormessage', node: r });
        }
      }
      return out;
    }

    function summaryLinks(el) {
      if (!el.id) return [];
      const root = el.getRootNode();
      const out = [];
      for (const a of root.querySelectorAll('a[href]')) {
        if (a.getAttribute('href') !== `#${el.id}` || !shown(a)) continue;
        const t = Fo.textOf(a);
        if (t) out.push({ text: t, how: 'in an error summary link', node: a });
      }
      return out;
    }

    function transitioning(el) {
      try {
        return el.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running');
      } catch {
        return false;
      }
    }

    function snapField(el) {
      const invalid = (el.getAttribute('aria-invalid') || '').toLowerCase();
      let colors = null;
      try {
        colors = S.snap(el);
      } catch {
        // detached
      }
      return {
        invalid,
        tied: tied(el, invalid),
        near: Fo.nearbyTexts(el),
        links: summaryLinks(el),
        colors,
        labelColor: el.labels && el.labels[0] ? S.styleOf(el.labels[0]).color : null,
        // A focus style can change any color (Bootstrap changes the border and
        // background), so colors are compared only between two snapshots
        // with the same focus state. While the page itself has no focus (the
        // tester is in the popup or side panel), the field keeps
        // activeElement but :focus stops matching, so it is not "focused".
        focused: document.hasFocus() && S.deepActiveElement(document) === el,
        // Mid-transition colors (a 0.15 s focus or blur fade, as Bootstrap
        // has) are neither look; such a snapshot is never compared.
        settling: transitioning(el),
      };
    }

    const sig = (s) =>
      JSON.stringify([s.invalid, s.tied.map((t) => t.text), s.near, s.links.map((t) => t.text), s.colors, s.labelColor]);

    function fields() {
      return Fo.collectFields(document).slice(0, FIELD_CAP);
    }

    // ------------------------------------------------------------- windows

    function onMutations(records) {
      if (!win) return;
      win.lastMutation = performance.now();
      for (const rec of records) {
        const nodes = rec.type === 'childList' ? [rec.target, ...rec.addedNodes] : [rec.target];
        for (const n of nodes) {
          const region = L.regionOf(n);
          if (region && !Fo.isTool(region)) win.regions.add(region);
        }
      }
    }

    function openWindow() {
      if (!active) return;
      const now = performance.now();
      if (win) {
        // A second trigger inside an open window (click, then submit) keeps it.
        return;
      }
      const pre = new Map();
      for (const el of fields()) {
        const snap = snapField(el);
        pre.set(el, snap);
        // The capture listener runs before the page's handlers, so this is
        // still the field before the submit: an unfocused look for a field
        // whose baseline was taken while it had focus.
        if (!baselines.has(el)) baselines.set(el, snap);
        else rebase(el, snap, true);
      }
      // focus: the last focusin inside the window. Focus that stays where it
      // was (Enter in a field) is not a move.
      win = { start: now, lastMutation: now, pre, regions: new Set(), invalid: new Map(), focus: null, timer: 0 };
      win.timer = setInterval(maybeClose, TICK_MS);
    }

    function maybeClose() {
      if (!win) return;
      const now = performance.now();
      const age = now - win.start;
      if (age < MIN_MS) return;
      if (now - win.lastMutation < QUIET_MS && age < MAX_MS) return;
      closeWindow();
    }

    function onClick(e) {
      const t = e.composedPath()[0];
      if (t && t.nodeType === Node.ELEMENT_NODE && t.closest(TRIGGER_SELECTOR)) openWindow();
    }

    function onKeydown(e) {
      if (e.key !== 'Enter') return;
      const t = e.composedPath()[0];
      if (Fo.isField(t) && t.tagName !== 'TEXTAREA') openWindow();
    }

    function onSubmit() {
      openWindow();
    }

    function onInvalid(e) {
      openWindow();
      const t = e.composedPath()[0];
      if (win && t && t.validationMessage) win.invalid.set(t, t.validationMessage);
    }

    function onFocusIn(e) {
      if (win) win.focus = e.composedPath()[0];
    }

    // A field whose baseline was taken while it had focus, or mid-transition,
    // gets a settled unfocused one once it loses focus, if no capture is open
    // and it shows no error yet.
    function onFocusOut(e) {
      const el = e.composedPath()[0];
      if (!Fo.isField(el)) return;
      const t = setTimeout(() => {
        timers.delete(t);
        rebase(el);
      }, REBASE_MS);
      timers.add(t);
    }

    function rebase(el, snap, opening) {
      const base = baselines.get(el);
      if (!active || (win && !opening) || !base || !(base.focused || base.settling) || results.has(el) || !el.isConnected) return;
      const now = snap || snapField(el);
      if (!now.focused && !now.settling) baselines.set(el, now);
    }

    // ------------------------------------------------------------- verdict

    // Compared with the baseline, or else with the snapshot taken when the
    // window opened, whichever has the same focus state as now and was not
    // taken mid-transition. null when neither qualifies, or when now is
    // mid-transition (not compared).
    function colorChanges(base, pre, now) {
      if (now.settling) return null;
      base = [base, pre].find((r) => r && !r.settling && r.focused === now.focused);
      if (!base) return null;
      const out = new Set();
      if (base.colors && now.colors) {
        for (const p of S.SNAP_PROPS) {
          if (base.colors[p] !== now.colors[p]) out.add(PROP_NAMES[p]);
        }
      }
      if (base.labelColor && now.labelColor && base.labelColor !== now.labelColor) out.add('label color');
      return [...out];
    }

    function verdict(el, base, now, ctx) {
      const texts = [];
      const add = (t) => {
        if (!texts.some((x) => x.text === t.text)) texts.push(t);
      };
      const baseTied = new Set(base.tied.map((t) => t.text));
      for (const t of now.tied) if (!baseTied.has(t.text)) add(t);
      const baseLinks = new Set(base.links.map((t) => t.text));
      for (const t of now.links) if (!baseLinks.has(t.text)) add(t);
      const baseNear = new Set(base.near);
      for (const t of now.near) {
        if (!baseNear.has(t) && !texts.some((x) => x.text.includes(t))) add({ text: t, how: 'near the field, not tied' });
      }
      const native = ctx.invalid.get(el) || '';
      const invalid = now.invalid === 'true' && base.invalid !== 'true';
      const compared = colorChanges(base, ctx.pre.get(el), now);
      const colors = compared || [];
      if (!texts.length && !native && !invalid && !colors.length) return null;

      // Announcement: a live region that changed in the window and holds this
      // field's error text or its name, or focus moved to the error or field.
      const name = A.compute(el).name.toLowerCase();
      const needles = [...texts.map((t) => t.text), native].filter(Boolean).map((t) => t.toLowerCase());
      let announced = '';
      for (const region of ctx.regions) {
        const rt = Fo.textOf(region);
        const low = rt.toLowerCase();
        if (rt && (needles.some((n) => low.includes(n) || n.includes(low)) || (name && low.includes(name)))) {
          const role = region.getAttribute('role');
          announced = `${quote(rt)} (${role ? `role="${role}"` : `aria-live="${L.politenessFor(region)}"`})`;
          break;
        }
      }
      let focusCue = '';
      if (ctx.focusEl === el) focusCue = 'Focus moved to the field.';
      else if (
        ctx.focusEl &&
        ctx.focusEl !== document.body &&
        ctx.focusEl.nodeType === Node.ELEMENT_NODE &&
        (texts.some((t) => t.node && ctx.focusEl.contains(t.node)) ||
          needles.some((n) => Fo.textOf(ctx.focusEl).toLowerCase().includes(n)))
      ) {
        focusCue = `Focus moved to ${globalThis.__a11ySelector(ctx.focusEl)}, which holds the error text.`;
      }

      const anyText = texts.length > 0;
      const tiedText = texts.some((t) => t.how.startsWith('tied'));
      const found = [];
      const missing = [];
      (anyText ? found : missing).push('error text in the page');
      (tiedText ? found : missing).push('text tied to the field (aria-describedby or aria-errormessage)');
      (now.invalid === 'true' ? found : missing).push('aria-invalid="true"');
      (announced || focusCue ? found : missing).push('an announcement (live region or role="alert") or a focus move to the error');
      if (colors.length) found.push(`a color change (${colors.join(', ')})`);

      const parts = ['After a submit, this field shows an error.'];
      if (anyText) parts.push(`Error text: ${texts.map((t) => `${quote(t.text)} (${t.how})`).join('; ')}.`);
      if (native) {
        parts.push(
          `Browser validation message: ${quote(native)} (the browser shows it in its own bubble, not in the page). ` +
            'TT 5.1 does not say whether this counts as error text: judge whether the error is identified and described in text.'
        );
      }
      if (!anyText && !native) {
        parts.push('No error text was found: none is tied to the field, none appeared near it or in an error summary, and the browser showed no validation message.');
      }
      if (announced) parts.push(`Announced: ${announced}.`);
      if (focusCue) parts.push(focusCue);
      if (!compared) parts.push('Colors were not compared: no earlier snapshot of the field had the same focus state with no color transition running, and focus styles change colors too.');
      parts.push(`Cues found: ${found.join('; ') || 'none'}. Cues missing: ${missing.join('; ') || 'none'}.`);

      const colorOnly = !anyText && !native && colors.length > 0;
      parts.push(
        colorOnly
          ? 'The error is shown only by a color change, which does not identify it in text (WCAG 3.3.1, TT 5.F; see also 1.4.1).'
          : 'Check that the field in error is identified and the error is described in text (WCAG 3.3.1, TT 5.F), and judge from the quoted text whether it says how to fix the input (3.3.3, TT 5.G).'
      );
      return F.makeFinding({
        tool: 'error-capture',
        wcag: '3.3.1',
        severity: colorOnly ? 'warn' : 'review',
        el,
        details: parts.join(' '),
      });
    }

    function closeWindow() {
      const ctx = win;
      win = null;
      clearInterval(ctx.timer);
      ctx.focusEl = ctx.focus;
      for (const el of fields()) {
        const post = snapField(el);
        const pre = ctx.pre.get(el);
        if (!baselines.has(el)) baselines.set(el, pre || post);
        // A field this window did not change keeps its earlier result, so a
        // later submit of another form cannot erase its announcement cues.
        const changed = !pre || sig(pre) !== sig(post) || ctx.invalid.has(el);
        if (results.has(el) && !changed) continue;
        try {
          const f = verdict(el, baselines.get(el), post, ctx);
          if (f) results.set(el, f);
        } catch {
          // element vanished mid-read
        }
      }
      captures++;
      document.documentElement.dataset.a11yErrorCaptures = String(captures);
      try {
        chrome.runtime.sendMessage({ type: 'errorCaptureUpdate', findings: collect() }).catch(() => {});
      } catch {
        // extension reloaded: the popup reads results with 'collect' instead
      }
    }

    // --------------------------------------------------------- start / stop

    function collect() {
      return [...results.values()];
    }

    function start() {
      if (active) return { active: true, fields: baselines.size };
      active = true;
      // The field that has focus records its focus style; its snapshot says
      // so (focused), and it is replaced when the field loses focus.
      for (const el of fields()) baselines.set(el, snapField(el));
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeydown, true);
      document.addEventListener('submit', onSubmit, true);
      document.addEventListener('invalid', onInvalid, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('focusout', onFocusOut, true);
      document.documentElement.dataset.a11yErrorCapture = 'on';
      document.documentElement.dataset.a11yErrorCaptures = '0';
      return { active: true, fields: baselines.size };
    }

    function stop() {
      if (!active) return { active: false };
      active = false;
      if (win) clearInterval(win.timer);
      win = null;
      if (observer) observer.disconnect();
      observer = null;
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('invalid', onInvalid, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      for (const t of timers) clearTimeout(t);
      timers = new Set();
      baselines = new Map();
      results = new Map();
      captures = 0;
      delete document.documentElement.dataset.a11yErrorCapture;
      delete document.documentElement.dataset.a11yErrorCaptures;
      return { active: false };
    }

    globalThis.__a11yCheckers.errorCapture = function errorCapture(cmd) {
      if (cmd === 'start') return start();
      if (cmd === 'stop') return stop();
      if (cmd === 'collect') return collect();
      return { active, captures };
    };
  })();
}
