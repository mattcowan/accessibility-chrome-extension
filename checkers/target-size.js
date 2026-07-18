// Target-size checker (WCAG 2.5.8): interactive targets must be at least
// 24x24 CSS px, unless the spacing / inline exceptions apply.
//   __a11yCheckers.targetSize() -> findings (and badges the offenders)
if (!globalThis.__a11yTargetSize) {
  globalThis.__a11yTargetSize = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const MIN = 24;
    const RADIUS = MIN / 2;

    function rectFor(el) {
      // Inline links can fragment across lines; measure the largest box.
      const rects = Array.from(el.getClientRects());
      if (!rects.length) return el.getBoundingClientRect();
      return rects.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    }

    // WCAG spacing-exception circle test: a 24px circle centered on the
    // undersized target must not intersect any other target's box (nor the
    // circle of another undersized target).
    function circleIntersectsRect(cx, cy, r, rect) {
      const nx = Math.max(rect.left, Math.min(cx, rect.right));
      const ny = Math.max(rect.top, Math.min(cy, rect.bottom));
      const dx = cx - nx;
      const dy = cy - ny;
      return dx * dx + dy * dy < r * r;
    }

    globalThis.__a11yCheckers.targetSize = function targetSize() {
      const findings = [];
      const all = F.collectInteractive(document);

      // Nested targets (button inside a link): keep the outermost only.
      const set = new Set(all);
      const targets = all.filter((el) => {
        let node = el.parentElement;
        while (node) {
          if (set.has(node)) return false;
          node = node.parentElement;
        }
        return true;
      });

      const measured = targets.map((el) => {
        const rect = rectFor(el);
        return { el, rect, small: rect.width < MIN || rect.height < MIN };
      });

      for (const t of measured) {
        if (!t.small) continue;
        const { el, rect } = t;
        const label = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

        const display = getComputedStyle(el).display;
        if (display === 'inline' || display === 'inline flow') {
          findings.push(
            F.makeFinding({
              tool: 'target-size',
              wcag: '2.5.8',
              severity: 'review',
              el,
              details: `Inline target ${label}px — likely exempt under the 2.5.8 inline exception (target in a sentence or list of text). Verify.`,
            })
          );
          continue;
        }

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let crowded = false;
        for (const other of measured) {
          if (other.el === t.el) continue;
          if (circleIntersectsRect(cx, cy, RADIUS, other.rect)) {
            crowded = true;
            break;
          }
          if (other.small) {
            const ox = other.rect.left + other.rect.width / 2;
            const oy = other.rect.top + other.rect.height / 2;
            const dx = cx - ox;
            const dy = cy - oy;
            if (dx * dx + dy * dy < MIN * MIN) {
              crowded = true;
              break;
            }
          }
        }

        const severity = crowded ? 'fail' : 'warn';
        findings.push(
          F.makeFinding({
            tool: 'target-size',
            wcag: '2.5.8',
            severity,
            el,
            details: crowded
              ? `Target is ${label}px (< 24×24) with other targets inside its 24px spacing circle — fails 2.5.8.`
              : `Target is ${label}px (< 24×24) but no other target intrudes on its 24px spacing circle — the spacing exception likely applies. Verify.`,
          })
        );
        if (globalThis.__a11yOverlay) {
          globalThis.__a11yOverlay.badge(el, label, severity);
          globalThis.__a11yOverlay.outline(el, severity);
        }
      }
      return findings;
    };
  })();
}
