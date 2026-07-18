// Text-spacing stress test (WCAG 1.4.12). Command-driven:
//   __a11yCheckers.textSpacing('apply' | 'remove' | 'status' | 'analyze')
// 'analyze' captures a clipping baseline BEFORE applying the overrides, so
// pre-existing clipping is never reported — only clipping the spacing causes.
if (!globalThis.__a11yTextSpacing) {
  globalThis.__a11yTextSpacing = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const STYLE_ID = '__a11y-text-spacing';
    const F = globalThis.__a11yFindings;

    const OVERRIDES =
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important;' +
      ' word-spacing: 0.16em !important; }\n' +
      'p { margin-bottom: 2em !important; }';

    function isApplied() {
      return !!document.getElementById(STYLE_ID);
    }

    function apply() {
      if (isApplied()) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = OVERRIDES;
      document.documentElement.appendChild(style);
    }

    function remove() {
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      globalThis.__a11yTextSpacingBaseline = null;
    }

    function clipState() {
      // Map of clipping element -> {sw, sh} for every element that hides
      // overflowing text content.
      const state = new Map();
      const all = [];
      F.collectMatching(document, '*', all);
      for (const el of all) {
        if (!el.clientWidth || !(el.textContent || '').trim()) continue;
        const style = getComputedStyle(el);
        const hidesX = /hidden|clip/.test(style.overflowX);
        const hidesY = /hidden|clip/.test(style.overflowY);
        if (!hidesX && !hidesY) continue;
        const clipsX = hidesX && el.scrollWidth > el.clientWidth + 1;
        const clipsY = hidesY && el.scrollHeight > el.clientHeight + 1;
        if (clipsX || clipsY) {
          state.set(el, { sw: el.scrollWidth, sh: el.scrollHeight });
        }
      }
      return state;
    }

    function analyze() {
      const findings = [];
      let baseline = globalThis.__a11yTextSpacingBaseline;

      if (!isApplied()) {
        baseline = clipState();
        globalThis.__a11yTextSpacingBaseline = baseline;
        apply();
        // Force a synchronous reflow so post-apply measurements are current.
        void document.documentElement.offsetHeight;
      } else if (!baseline) {
        baseline = new Map();
        findings.push(
          F.makeFinding({
            tool: 'text-spacing',
            wcag: '1.4.12',
            severity: 'review',
            el: null,
            details:
              'Overrides were already applied with no recorded baseline; results may include pre-existing clipping. Remove overrides and re-run for a clean diff.',
          })
        );
      }

      const after = clipState();
      for (const [el, m] of after) {
        const base = baseline.get(el);
        const style = getComputedStyle(el);
        const ellipsis =
          style.textOverflow === 'ellipsis' && /nowrap/.test(style.whiteSpace);
        if (base) {
          // Clipped before too — only interesting if ellipsis text got longer
          // (more content hidden than the author designed for).
          if (ellipsis && m.sw > base.sw + 4) {
            findings.push(
              F.makeFinding({
                tool: 'text-spacing',
                wcag: '1.4.12',
                severity: 'review',
                el,
                details: `Ellipsis truncation hides more text under spacing overrides (scrollWidth ${base.sw}px -> ${m.sw}px). Verify no information is lost.`,
              })
            );
          }
          continue;
        }
        findings.push(
          F.makeFinding({
            tool: 'text-spacing',
            wcag: '1.4.12',
            severity: ellipsis ? 'review' : 'fail',
            el,
            details: ellipsis
              ? 'Text becomes ellipsis-truncated only under spacing overrides. Verify no information is lost.'
              : `Text is clipped when WCAG 1.4.12 spacing overrides are applied (scrollWidth ${m.sw}px x scrollHeight ${m.sh}px exceeds visible box). Content or functionality is lost.`,
          })
        );
      }
      return findings;
    }

    globalThis.__a11yCheckers.textSpacing = function textSpacing(cmd) {
      switch (cmd) {
        case 'apply':
          apply();
          return { applied: true };
        case 'remove':
          remove();
          return { applied: false };
        case 'status':
          return { applied: isApplied() };
        case 'analyze':
          return analyze();
        default:
          throw new Error(`textSpacing: unknown command ${cmd}`);
      }
    };
  })();
}
