// Focus visibility walker (WCAG 2.4.7): badges the tab order, then checks
// each focusable element for a detectable focus indicator.
//   __a11yCheckers.focusWalker() -> Promise<findings>
//
// Heuristic, honestly graded: synthetic focus() may not match :focus-visible,
// so a computed-style diff is combined with a CSSOM scan of :focus rules.
// Cross-origin stylesheets can't be read; when any are skipped, hard fails
// are downgraded to 'review'. Needs checkers/lib/focus-style.js (the style
// diff is shared with the focus locator).
if (!globalThis.__a11yFocusWalker) {
  globalThis.__a11yFocusWalker = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const { snap, diffKind, deepActiveElement } = globalThis.__a11yFocusStyle;
    const CAP = 400;

    // Does this Chrome honor focus({focusVisible:true})? Probe with a rule
    // that only applies under :focus-visible.
    function probeFocusVisible() {
      const style = document.createElement('style');
      style.textContent =
        '#__a11y-fv-probe:focus-visible { outline: 3px solid rgb(1,2,3) !important; }';
      const btn = document.createElement('button');
      btn.id = '__a11y-fv-probe';
      btn.style.cssText = 'position:fixed;top:-100px;left:-100px;';
      document.documentElement.append(style, btn);
      let supported = false;
      try {
        btn.focus({ preventScroll: true, focusVisible: true });
        supported = getComputedStyle(btn).outlineColor === 'rgb(1, 2, 3)';
      } finally {
        btn.blur();
        btn.remove();
        style.remove();
      }
      return supported;
    }

    // Collect :focus/:focus-visible rules from readable stylesheets, media
    // conditions respected. Returns {rules: [{stripped, style}], skipped}.
    function collectFocusRules() {
      const rules = [];
      let skipped = 0;
      function walk(list) {
        for (const rule of list) {
          try {
            if (rule.media && rule.media.mediaText) {
              if (!matchMedia(rule.media.mediaText).matches) continue;
            }
            if (rule.cssRules && !rule.selectorText) {
              walk(rule.cssRules);
              continue;
            }
            if (!rule.selectorText || !rule.selectorText.includes(':focus')) continue;
            for (const part of rule.selectorText.split(',')) {
              if (!part.includes(':focus')) continue;
              const stripped = part
                .replace(/:focus-visible|:focus-within|:focus/g, '')
                .trim();
              rules.push({ stripped: stripped || '*', style: rule.style });
            }
          } catch {
            // individual rule quirks — skip
          }
        }
      }
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules);
        } catch {
          skipped++;
        }
      }
      return { rules, skipped };
    }

    function rulesFor(el, rules) {
      return rules.filter((r) => {
        try {
          return el.matches(r.stripped);
        } catch {
          return false;
        }
      });
    }

    function ruleIndicator(matched) {
      // Returns 'positive' | 'suppressive' | 'none' for the matched rules.
      let positive = false;
      let suppressive = false;
      for (const r of matched) {
        const s = r.style;
        const ow = s.getPropertyValue('outline-width');
        const os = s.getPropertyValue('outline-style');
        const outline = s.getPropertyValue('outline');
        if (
          /none|hidden/.test(os) ||
          /^\s*(none|0(px)?)\s*$/.test(outline) ||
          /^0(px)?$/.test(ow.trim())
        ) {
          suppressive = true;
        } else if (outline || os || ow || s.getPropertyValue('box-shadow')) {
          if (s.getPropertyValue('box-shadow') !== 'none') positive = true;
          if (outline || os || ow) positive = true;
        } else if (
          s.getPropertyValue('background-color') ||
          s.getPropertyValue('border-color') ||
          s.getPropertyValue('border') ||
          s.getPropertyValue('text-decoration')
        ) {
          positive = true;
        }
      }
      if (positive) return 'positive';
      if (suppressive) return 'suppressive';
      return 'none';
    }

    globalThis.__a11yCheckers.focusWalker = async function focusWalker() {
      const findings = [];
      const focusables = F.collectFocusables(document);
      const truncated = focusables.length > CAP;
      const walkList = focusables.slice(0, CAP);

      if (globalThis.__a11yOverlay) {
        walkList.forEach((el, i) => globalThis.__a11yOverlay.badge(el, String(i + 1), 'info'));
      }
      if (truncated) {
        findings.push(
          F.makeFinding({
            tool: 'focus-visibility',
            wcag: '2.4.7',
            severity: 'review',
            el: null,
            details: `Page has ${focusables.length} focusable elements; only the first ${CAP} were checked.`,
          })
        );
      }

      for (const el of walkList) {
        const ti = parseInt(el.getAttribute('tabindex') || '0', 10);
        if (ti > 0) {
          findings.push(
            F.makeFinding({
              tool: 'focus-visibility',
              wcag: '2.4.3',
              severity: 'warn',
              el,
              details: `Positive tabindex (${ti}) overrides the natural tab order — a maintenance and focus-order hazard.`,
            })
          );
        }
      }

      const fvSupported = probeFocusVisible();
      const { rules, skipped } = collectFocusRules();
      const prevActive = deepActiveElement();
      const prevScroll = { x: window.scrollX, y: window.scrollY };

      try {
        for (const el of walkList) {
          if (el.tagName === 'IFRAME') {
            findings.push(
              F.makeFinding({
                tool: 'focus-visibility',
                wcag: '2.4.7',
                severity: 'review',
                el,
                details: 'Focusable iframe — its internal focus indicators must be checked separately.',
              })
            );
            continue;
          }

          const before = snap(el);
          try {
            el.focus({ preventScroll: true, focusVisible: true });
          } catch {
            el.focus();
          }
          if (deepActiveElement() !== el) {
            findings.push(
              F.makeFinding({
                tool: 'focus-visibility',
                wcag: '2.4.7',
                severity: 'review',
                el,
                details: 'Element did not accept programmatic focus; verify keyboard focus behavior manually.',
              })
            );
            continue;
          }
          const kind = diffKind(before, snap(el));
          if (kind === 'strong') continue;

          if (kind === 'weak') {
            findings.push(
              F.makeFinding({
                tool: 'focus-visibility',
                wcag: '2.4.7',
                severity: 'warn',
                el,
                details:
                  'Focus is indicated only by a subtle change (background/border/color, no outline or shadow). Verify it is visible with 3:1 contrast.',
              })
            );
            continue;
          }

          // No visible change under synthetic focus — consult the CSSOM.
          const matched = rulesFor(el, rules);
          const indicator = ruleIndicator(matched);
          if (indicator === 'positive') {
            // Styled via :focus-visible that synthetic focus didn't trigger.
            continue;
          }

          let severity = 'fail';
          let details =
            indicator === 'suppressive'
              ? 'Focus outline is suppressed (outline: none/0) with no replacement indicator — keyboard users cannot see focus.'
              : 'No focus indicator detected: no style change on focus and no :focus/:focus-visible rule applies.';
          if (indicator === 'none' && !fvSupported) {
            severity = 'review';
            details +=
              ' (Could not fully verify: this Chrome ignores focus({focusVisible}) and the default UA ring may still appear for real keyboard focus.)';
          }
          if (skipped > 0 && severity === 'fail') {
            severity = 'review';
            details += ` (${skipped} cross-origin stylesheet(s) could not be read; an indicator may be defined there.)`;
          }
          findings.push(
            F.makeFinding({ tool: 'focus-visibility', wcag: '2.4.7', severity, el, details })
          );
          if (globalThis.__a11yOverlay && severity === 'fail') {
            globalThis.__a11yOverlay.outline(el, 'fail');
          }
        }
      } finally {
        const active = deepActiveElement();
        if (active && active.blur) active.blur();
        if (prevActive && prevActive !== document.body && prevActive.focus) {
          try {
            prevActive.focus({ preventScroll: true });
          } catch {
            // best effort
          }
        }
        window.scrollTo(prevScroll.x, prevScroll.y);
      }
      return findings;
    };
  })();
}
