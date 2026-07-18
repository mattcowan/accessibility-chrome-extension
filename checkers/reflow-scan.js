// Reflow overflow scan (WCAG 1.4.10). Run with the popup's Reflow toggle on
// (CDP viewport override to 320 CSS px); flags what forces horizontal scroll.
//   __a11yCheckers.reflowScan() -> findings
if (!globalThis.__a11yReflowScan) {
  globalThis.__a11yReflowScan = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    // Content for which 2-D scrolling is allowed by 1.4.10.
    const EXEMPT = new Set(['TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'PRE', 'CODE', 'VIDEO', 'CANVAS', 'SVG', 'MAP', 'OBJECT', 'EMBED']);

    globalThis.__a11yCheckers.reflowScan = function reflowScan() {
      const findings = [];
      const viewport = document.documentElement.clientWidth;

      if (viewport > 340) {
        findings.push(
          F.makeFinding({
            tool: 'reflow',
            wcag: '1.4.10',
            severity: 'review',
            el: null,
            details: `Viewport is ${viewport}px — the 320px reflow override is not active. Enable the Reflow test toggle and re-run.`,
          })
        );
      }

      const scroller = document.scrollingElement || document.documentElement;
      if (scroller.scrollWidth <= viewport + 1) return findings;

      const overflowing = [];
      const all = [];
      F.collectMatching(document, '*', all);
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.right > viewport + 1 + window.scrollX || rect.width > viewport + 1) {
          overflowing.push(el);
        }
      }

      // Outermost offenders only — a wide child inside a wide wrapper is one
      // problem, not two.
      const set = new Set(overflowing);
      for (const el of overflowing) {
        let node = el.parentElement;
        let nested = false;
        while (node) {
          if (set.has(node)) {
            nested = true;
            break;
          }
          node = node.parentElement;
        }
        if (nested) continue;

        const exempt =
          EXEMPT.has(el.tagName) || el.closest('table, pre') !== null;
        const rect = el.getBoundingClientRect();
        findings.push(
          F.makeFinding({
            tool: 'reflow',
            wcag: '1.4.10',
            severity: exempt ? 'review' : 'fail',
            el,
            details: exempt
              ? `Wide ${el.tagName.toLowerCase()} (${Math.round(rect.width)}px) causes horizontal scroll at 320px — likely exempt (data table / image / code), but verify it needs 2-D scrolling.`
              : `Element is ${Math.round(rect.width)}px wide at a 320px viewport, forcing horizontal scrolling — content must reflow (WCAG 1.4.10).`,
          })
        );
      }
      return findings;
    };
  })();
}
