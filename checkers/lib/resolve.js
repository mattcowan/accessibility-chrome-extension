// Resolves a finding's selector string back to a live element. Exact inverse
// of selector.js's output format: shadow-DOM parts are joined with " >>> "
// (each part valid within its own root, open roots only) — keep the two in
// sync. Injected (classic script) by the popup's finding-reveal feature.
if (!globalThis.__a11yResolve) {
  globalThis.__a11yResolve = function resolve(selector) {
    if (!selector || selector === '(page)' || selector === '(unknown)') return null;
    const parts = selector.split(' >>> ');
    let root = document;
    let el = null;
    for (let i = 0; i < parts.length; i++) {
      try {
        el = root.querySelector(parts[i]);
      } catch {
        return null;
      }
      if (!el) return null;
      if (i < parts.length - 1) {
        root = el.shadowRoot;
        if (!root) return null;
      }
    }
    return el;
  };
}
