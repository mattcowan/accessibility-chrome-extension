// Live-region detection shared by the live-region monitor (4.1.3), Error
// capture (3.3.1) and the Input watcher (4.1.2). Injected (classic script)
// before any of them.
//   REGION_SELECTOR      -> elements that can be live regions
//   politenessFor(el)    -> 'polite' | 'assertive' | null (not live)
//   regionOf(node)       -> the closest live ancestor-or-self element, or null
if (!globalThis.__a11yLive) {
  globalThis.__a11yLive = (function () {
    const REGION_SELECTOR = '[aria-live], [role="status"], [role="log"], [role="alert"], output';

    function politenessFor(el) {
      const live = (el.getAttribute('aria-live') || '').toLowerCase();
      if (live === 'off') return null;
      if (live === 'polite' || live === 'assertive') return live;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'alert') return 'assertive';
      if (role === 'status' || role === 'log') return 'polite';
      if (el.tagName === 'OUTPUT') return 'polite';
      // aria-live present but with an unrecognized value — treat as polite.
      if (live) return 'polite';
      return null;
    }

    function regionOf(node) {
      let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
      while (el) {
        if (el.matches(REGION_SELECTOR) && politenessFor(el)) return el;
        el = el.parentElement;
      }
      return null;
    }

    return { REGION_SELECTOR, politenessFor, regionOf };
  })();
}
