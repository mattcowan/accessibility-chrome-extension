// Page-side helpers for the popup's own small operations (reveal a finding,
// highlight all, clear overlays, read the stateful tools' page markers).
// They used to be inline `func`s in popup-side executeScript calls; every
// injection now goes through the SW's `exec` route (#15), which can only call
// a named method on an allowed global, so they live here. Injected (classic
// script) on demand; reveal/highlight need resolve.js and overlay.js first.
if (!globalThis.__a11yOps) {
  globalThis.__a11yOps = {
    // Scroll a finding's element into view and outline it. false = not in
    // this frame (findings are collected allFrames, so the popup asks every
    // frame).
    reveal(sel, sev) {
      const el = globalThis.__a11yResolve(sel);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      globalThis.__a11yOverlay.outline(el, sev);
      globalThis.__a11yOverlay.badge(el, sev.charAt(0).toUpperCase(), sev);
      return true;
    },

    // Outline every {selector, severity} found in this frame; returns the count.
    highlight(list) {
      let hit = 0;
      for (const item of list) {
        const el = globalThis.__a11yResolve(item.selector);
        if (!el) continue;
        globalThis.__a11yOverlay.outline(el, item.severity);
        globalThis.__a11yOverlay.badge(el, item.severity.charAt(0).toUpperCase(), item.severity);
        hit++;
      }
      return hit;
    },

    clearOverlays() {
      if (globalThis.__a11yOverlay) globalThis.__a11yOverlay.clear();
    },

    // Which stateful tools are running on this page, from the DOM markers
    // each one sets (the popup re-syncs its button labels from these).
    markers() {
      const ds = document.documentElement.dataset;
      return {
        accname: !!document.getElementById('__a11y-accname-tip'),
        focusLocator: ds.a11yFocusLocator === 'on',
        errorCapture: ds.a11yErrorCapture === 'on',
        inputWatcher: ds.a11yInputWatcher === 'on',
        liveMonitor: ds.a11yLiveMonitor === 'on',
      };
    },

    // Error capture's status plus its results so far, or null when it is not
    // running (no need to inject its files to find out).
    errorCaptureState() {
      const ec = globalThis.__a11yCheckers && globalThis.__a11yCheckers.errorCapture;
      if (!ec || document.documentElement.dataset.a11yErrorCapture !== 'on') return null;
      return { ...ec('status'), findings: ec('collect') };
    },
  };
}
