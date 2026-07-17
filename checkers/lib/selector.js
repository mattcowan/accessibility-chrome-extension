// Unique CSS selector generation for findings. Injected (classic script)
// before every checker via chrome.scripting.executeScript files[].
// Sibling logic lives in tools/keyboard-trap-scan/lib/focusables.js — the
// Node scanner must stay standalone, so keep the two in sync by hand.
if (!globalThis.__a11ySelector) {
  globalThis.__a11ySelector = (function () {
    const DATA_ATTRS = ['data-testid', 'data-test', 'data-id', 'data-name'];
    const MAX_SEGMENTS = 8;

    function isUnique(root, sel, el) {
      try {
        const found = root.querySelectorAll(sel);
        return found.length === 1 && found[0] === el;
      } catch {
        return false;
      }
    }

    function attrValueEscape(v) {
      return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function anchorFor(el, root) {
      if (el.id && isUnique(root, `#${CSS.escape(el.id)}`, el)) {
        return `#${CSS.escape(el.id)}`;
      }
      for (const attr of DATA_ATTRS) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) {
          const sel = `[${attr}="${attrValueEscape(v)}"]`;
          if (isUnique(root, sel, el)) return sel;
        }
      }
      return null;
    }

    function segment(el) {
      const tag = el.tagName.toLowerCase();
      const parent = el.parentNode;
      if (!parent || !parent.children) return tag;
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (sameTag.length <= 1) return tag;
      return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }

    function selectorWithinRoot(el, root) {
      const direct = anchorFor(el, root);
      if (direct) return direct;
      const segments = [segment(el)];
      let node = el.parentElement;
      while (node && segments.length < MAX_SEGMENTS) {
        const anchor = anchorFor(node, root);
        if (anchor) {
          segments.unshift(anchor);
          return segments.join(' > ');
        }
        segments.unshift(segment(node));
        node = node.parentElement;
      }
      return segments.join(' > ');
    }

    // Returns a selector string. For shadow-DOM elements the parts are joined
    // with " >>> " (non-standard, human-readable notation for reports; each
    // part is valid within its own root).
    return function uniqueSelector(el) {
      if (!el || !el.tagName) return '(unknown)';
      const parts = [];
      let node = el;
      let guard = 0;
      while (node && guard++ < 10) {
        const root = node.getRootNode();
        parts.unshift(selectorWithinRoot(node, root));
        node = root instanceof ShadowRoot ? root.host : null;
      }
      return parts.join(' >>> ');
    };
  })();
}
