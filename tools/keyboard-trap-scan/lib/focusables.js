// In-page helpers for the scanner, installed via page.addInitScript so they
// survive navigation. Sibling of the extension's checkers/lib/selector.js +
// findings.js — keep the selector/focusable logic in sync by hand.

export const HELPERS_SOURCE = `
window.__kt = (function () {
  const ids = new WeakMap();
  let nextId = 1;

  function idOf(el) {
    if (!ids.has(el)) ids.set(el, nextId++);
    return ids.get(el);
  }

  function esc(v) {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : v;
  }

  function segment(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentNode;
    if (!parent || !parent.children) return tag;
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length <= 1) return tag;
    return tag + ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
  }

  function selector(el) {
    if (!el || !el.tagName) return '(unknown)';
    if (el.id) return '#' + esc(el.id);
    const segments = [segment(el)];
    let node = el.parentElement;
    while (node && segments.length < 8) {
      if (node.id) {
        segments.unshift('#' + esc(node.id));
        return segments.join(' > ');
      }
      segments.unshift(segment(node));
      node = node.parentElement;
    }
    return segments.join(' > ');
  }

  const FOCUSABLE = [
    'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea',
    'iframe', 'audio[controls]', 'video[controls]', 'summary',
    '[contenteditable]:not([contenteditable="false"])', '[tabindex]',
  ].join(', ');

  function visible(el) {
    if (el.closest && el.closest('[inert]')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collect(root, out) {
    for (const el of root.querySelectorAll(FOCUSABLE)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
  }

  function countFocusables() {
    const all = [];
    collect(document, all);
    return all.filter((el) => {
      if (el.disabled) return false;
      const ti = el.getAttribute('tabindex');
      if (ti !== null && parseInt(ti, 10) < 0) return false;
      return visible(el);
    }).length;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  function describeActive() {
    const a = deepActive();
    if (!a || a === document.body || a === document.documentElement) {
      return { atBody: true, id: 0, selector: '(body)', tag: 'body' };
    }
    return {
      atBody: false,
      id: idOf(a),
      selector: selector(a),
      tag: a.tagName.toLowerCase() + (a.tagName === 'IFRAME' ? ' (iframe — contents opaque)' : ''),
    };
  }

  return { countFocusables, describeActive };
})();
`;
