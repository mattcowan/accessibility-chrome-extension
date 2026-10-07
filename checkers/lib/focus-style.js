// Focus-indicator style diff shared by the Focus visibility walker (2.4.7) and
// the focus locator. Injected (classic script) before either checker.
//   snap(el)          -> {prop: computed value} for the indicator properties
//   diffKind(a, b)    -> 'strong' (outline/box-shadow changed) | 'weak'
//                        (only color/background/border/underline) | 'none'
//   deepActiveElement(doc) -> the focused element, through open shadow roots
if (!globalThis.__a11yFocusStyle) {
  globalThis.__a11yFocusStyle = (function () {
    const SNAP_PROPS = [
      'outlineStyle',
      'outlineWidth',
      'outlineColor',
      'boxShadow',
      'backgroundColor',
      'color',
      'borderTopColor',
      'borderRightColor',
      'borderBottomColor',
      'borderLeftColor',
      'textDecorationLine',
    ];

    // The element's own window: elements in same-origin iframes resolve their
    // styles (and media queries) against their frame, not the top window.
    function styleOf(el, pseudo) {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      return view.getComputedStyle(el, pseudo || null);
    }

    function snap(el) {
      const cs = styleOf(el);
      const out = {};
      for (const p of SNAP_PROPS) out[p] = cs[p];
      return out;
    }

    function diffKind(a, b) {
      if (
        a.outlineStyle !== b.outlineStyle ||
        a.outlineWidth !== b.outlineWidth ||
        a.outlineColor !== b.outlineColor ||
        a.boxShadow !== b.boxShadow
      ) {
        return 'strong';
      }
      for (const p of SNAP_PROPS) {
        if (a[p] !== b[p]) return 'weak';
      }
      return 'none';
    }

    function deepActiveElement(doc) {
      let a = (doc || document).activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) {
        a = a.shadowRoot.activeElement;
      }
      return a;
    }

    return { SNAP_PROPS, styleOf, snap, diffKind, deepActiveElement };
  })();
}
