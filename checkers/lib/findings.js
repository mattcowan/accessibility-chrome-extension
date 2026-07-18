// Shared finding construction + DOM traversal helpers. Injected (classic
// script) after selector.js and before each checker.
if (!globalThis.__a11yFindings) {
  globalThis.__a11yFindings = (function () {
    // Findings schema shared with the Playwright keyboard-trap scanner:
    // {tool, wcag, severity, selector, snippet, details} — the popup stamps
    // url + timestamp (and diff status) before storing/exporting.
    function makeFinding({ tool, wcag, severity, el, details }) {
      return {
        tool,
        wcag,
        severity, // 'fail' | 'warn' | 'review'
        selector: el ? globalThis.__a11ySelector(el) : '(page)',
        snippet: el ? snippet(el) : '',
        details: details || '',
      };
    }

    // Opening tag only — child content is noise in a CSV cell.
    function snippet(el) {
      try {
        const clone = el.cloneNode(false);
        let html = clone.outerHTML || `<${el.tagName.toLowerCase()}>`;
        // Self-closed pair rendering like <div></div> — keep just the open tag.
        const end = html.indexOf('>');
        if (end !== -1) html = html.slice(0, end + 1);
        return html.length > 200 ? html.slice(0, 197) + '...' : html;
      } catch {
        return `<${el.tagName ? el.tagName.toLowerCase() : '?'}>`;
      }
    }

    const FOCUSABLE_SELECTOR = [
      'a[href]',
      'area[href]',
      'button',
      'input',
      'select',
      'textarea',
      'iframe',
      'audio[controls]',
      'video[controls]',
      'summary',
      '[contenteditable]:not([contenteditable="false"])',
      '[tabindex]',
    ].join(', ');

    // Elements a pointer/touch user can activate (target-size + hover checks).
    const INTERACTIVE_SELECTOR = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="option"]',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]',
    ].join(', ');

    function isVisible(el) {
      if (el.closest && el.closest('[inert]')) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function collectMatching(root, selector, out) {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      // Open shadow roots only; closed roots are a documented limitation.
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collectMatching(el.shadowRoot, selector, out);
      }
    }

    // Focusables in tab order: positive tabindex first (ascending, stable),
    // then traversal order (≈ DOM order; exact cross-shadow ordering is
    // approximated by traversal order).
    function collectFocusables(root) {
      const all = [];
      collectMatching(root || document, FOCUSABLE_SELECTOR, all);
      const tabbable = all.filter((el) => {
        if (el.disabled) return false;
        const ti = el.getAttribute('tabindex');
        if (ti !== null && parseInt(ti, 10) < 0) return false;
        return isVisible(el);
      });
      const positive = [];
      const normal = [];
      for (const el of tabbable) {
        const ti = parseInt(el.getAttribute('tabindex') || '0', 10);
        (ti > 0 ? positive : normal).push(el);
      }
      positive.sort((a, b) => {
        return parseInt(a.getAttribute('tabindex'), 10) - parseInt(b.getAttribute('tabindex'), 10);
      });
      return positive.concat(normal);
    }

    function collectInteractive(root) {
      const all = [];
      collectMatching(root || document, INTERACTIVE_SELECTOR, all);
      return all.filter(isVisible);
    }

    return {
      makeFinding,
      snippet,
      isVisible,
      collectFocusables,
      collectInteractive,
      collectMatching,
      FOCUSABLE_SELECTOR,
      INTERACTIVE_SELECTOR,
    };
  })();
}
