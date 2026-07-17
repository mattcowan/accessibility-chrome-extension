// Badge overlay for focus-walker / target-size results. Injected (classic
// script) on demand; one absolutely-positioned layer, pointer-events none.
if (!globalThis.__a11yOverlay) {
  globalThis.__a11yOverlay = (function () {
    const LAYER_ID = '__a11y-overlay';

    const COLORS = {
      fail: { bg: '#b91c1c', fg: '#ffffff' },
      warn: { bg: '#b45309', fg: '#ffffff' },
      review: { bg: '#475569', fg: '#ffffff' },
      info: { bg: '#0f766e', fg: '#ffffff' },
    };

    function layer() {
      let el = document.getElementById(LAYER_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = LAYER_ID;
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText =
          'position:absolute;top:0;left:0;width:0;height:0;' +
          'z-index:2147483647;pointer-events:none;';
        document.documentElement.appendChild(el);
      }
      return el;
    }

    function badge(target, text, severity) {
      const rect = target.getBoundingClientRect();
      const c = COLORS[severity] || COLORS.info;
      const b = document.createElement('div');
      b.textContent = text;
      b.style.cssText =
        'position:absolute;' +
        `top:${Math.max(0, rect.top + window.scrollY - 9)}px;` +
        `left:${Math.max(0, rect.left + window.scrollX - 9)}px;` +
        `background:${c.bg};color:${c.fg};` +
        'font:700 11px/18px system-ui,sans-serif;' +
        'min-width:18px;height:18px;padding:0 4px;border-radius:9px;' +
        'text-align:center;box-shadow:0 0 0 2px #fff,0 1px 3px rgba(0,0,0,.4);' +
        'white-space:nowrap;';
      layer().appendChild(b);
      return b;
    }

    function outline(target, severity) {
      const rect = target.getBoundingClientRect();
      const c = COLORS[severity] || COLORS.info;
      const o = document.createElement('div');
      o.style.cssText =
        'position:absolute;' +
        `top:${rect.top + window.scrollY}px;left:${rect.left + window.scrollX}px;` +
        `width:${rect.width}px;height:${rect.height}px;` +
        `outline:2px dashed ${c.bg};outline-offset:1px;`;
      layer().appendChild(o);
      return o;
    }

    function clear() {
      const el = document.getElementById(LAYER_ID);
      if (el) el.remove();
    }

    return { badge, outline, clear };
  })();
}
