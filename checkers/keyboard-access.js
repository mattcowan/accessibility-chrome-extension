// Mouse-only element scan (WCAG 2.1.1, Trusted Tester 4.A):
//   __a11yCheckers.keyboardAccess({listenerPaths}) -> findings
// Reports elements that look operable by mouse (a pointer cursor the element
// sets itself, an onclick-style attribute, an interactive role, or a click
// listener) but that Tab cannot reach: not tabbable and not inside a
// tabbable element. Every finding is `review` — TT 4.A step 3 accepts another
// keyboard method for the same function, and only a person can judge that.
//
// listenerPaths: [{path, tag}] for elements with click-type listeners, read
// by the service worker through CDP (DOMDebugger.getEventListeners). path is
// the child-index path from the top document (-1 = enter the shadow root);
// tag is the element's tagName at read time, so a path that now lands on a
// different element (the DOM changed between the read and the scan) is
// dropped. Content scripts cannot see addEventListener listeners. Applied in
// the top frame only. Known gaps: listeners inside iframes (static signals
// still run in every frame) and inside closed shadow roots (the path cannot
// enter them). null = not available.
//
// Never focuses, clicks or presses keys.
if (!globalThis.__a11yKeyboardAccess) {
  globalThis.__a11yKeyboardAccess = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const CAP = 300;

    const CLICK_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ondblclick'];

    const INTERACTIVE_ROLES = new Set([
      'button',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'checkbox',
      'radio',
      'switch',
      'option',
      'treeitem',
      'slider',
      'spinbutton',
      'combobox',
      'textbox',
      'searchbox',
    ]);

    // Composite widgets move focus among their items with arrow keys
    // (roving tabindex or aria-activedescendant); TT 4.A counts arrow keys
    // as keyboard access, so their tabindex="-1" items are reachable.
    const COMPOSITE_SELECTOR = [
      '[role="tablist"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="menubar"]',
      '[role="tree"]',
      '[role="treegrid"]',
      '[role="grid"]',
      '[role="radiogroup"]',
      '[role="toolbar"]',
    ].join(', ');

    function role(el) {
      return (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    }

    function isTabbable(el) {
      if (!el.matches(F.FOCUSABLE_SELECTOR)) return false;
      if (el.matches(':disabled')) return false;
      // Chrome reports tabIndex -1 for an editing host with no tabindex
      // attribute, but Tab reaches it (Lexical, CKEditor 5 roots). Only the
      // host is a tab stop, not editable descendants.
      if (!el.hasAttribute('tabindex') && el.isContentEditable) {
        const parent = el.parentElement;
        return !parent || !parent.isContentEditable;
      }
      // tabIndex is -1 for an invalid or negative tabindex attribute.
      return el.tabIndex >= 0;
    }

    // Composed-tree parent: slot for slotted content, host for a shadow root.
    function composedParent(el) {
      if (el.assignedSlot) return el.assignedSlot;
      if (el.parentElement) return el.parentElement;
      const root = el.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    }

    // inert is inherited through the flat tree, but F.isVisible's
    // closest('[inert]') stops at a shadow boundary. Neither mouse nor
    // keyboard reaches inert content, so it is neither a candidate nor a
    // keyboard path.
    function isInert(el) {
      for (let n = el; n; n = composedParent(n)) {
        if (n.hasAttribute('inert')) return true;
      }
      return false;
    }

    function tabbableAncestor(el) {
      for (let p = composedParent(el); p; p = composedParent(p)) {
        if (isTabbable(p)) return p;
        // Clicking anywhere in a <label> activates its control.
        if (p.tagName === 'LABEL' && p.control && isTabbable(p.control)) return p;
      }
      return null;
    }

    function inReachableComposite(el) {
      const box = el.closest(COMPOSITE_SELECTOR);
      if (!box) return false;
      if (isTabbable(box) || box.hasAttribute('aria-activedescendant')) return true;
      const items = [];
      F.collectMatching(box, F.FOCUSABLE_SELECTOR, items);
      return items.some(isTabbable);
    }

    function firstTabbableInside(el) {
      const items = [];
      F.collectMatching(el, F.FOCUSABLE_SELECTOR, items);
      return items.find((i) => isTabbable(i) && F.isVisible(i) && !isInert(i)) || null;
    }

    function resolvePath(path) {
      let node = document;
      for (const step of path) {
        if (step === -1) {
          node = node.shadowRoot;
        } else {
          node = node && node.children ? node.children[step] : null;
        }
        if (!node) return null;
      }
      return node.nodeType === Node.ELEMENT_NODE ? node : null;
    }

    function listenerSet(paths) {
      const set = new Set();
      if (!Array.isArray(paths) || window !== window.top) return set;
      for (const p of paths) {
        const found = p && Array.isArray(p.path) ? resolvePath(p.path) : null;
        const el = found && found.tagName === p.tag ? found : null;
        // A listener on <html>/<body> is delegation: it says nothing about
        // which element is clickable.
        if (el && el !== document.documentElement && el !== document.body) set.add(el);
      }
      return set;
    }

    function signalsFor(el, listeners) {
      const signals = [];
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer') {
        // Count the cursor only where it is set, not where it is inherited.
        const parent = composedParent(el);
        if (!parent || getComputedStyle(parent).cursor !== 'pointer') signals.push('a pointer cursor');
      }
      const attr = CLICK_ATTRS.find((a) => el.hasAttribute(a));
      if (attr) signals.push(`an ${attr} attribute`);
      const r = role(el);
      if (INTERACTIVE_ROLES.has(r)) signals.push(`role="${r}"`);
      if (listeners.has(el)) signals.push('a click listener');
      return signals;
    }

    function isOwnUi(el) {
      return /^__a11y/.test(el.id) || !!el.closest('[id^="__a11y"]');
    }

    globalThis.__a11yCheckers.keyboardAccess = function keyboardAccess(arg) {
      const listeners = listenerSet(arg && arg.listenerPaths);
      const all = [];
      F.collectMatching(document, '*', all);
      const findings = [];
      let total = 0;

      for (const el of all) {
        if (el === document.documentElement || el === document.body) continue;
        if (isTabbable(el) || isOwnUi(el)) continue;
        if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
        const signals = signalsFor(el, listeners);
        if (!signals.length) continue;
        if (!F.isVisible(el) || isInert(el)) continue;
        if (el.tagName === 'LABEL' && el.control && isTabbable(el.control)) continue;
        if (tabbableAncestor(el)) continue;
        if (inReachableComposite(el)) continue;
        // Delegation: a container whose only sign of being clickable is a
        // listener, and that holds focusable controls, is almost always one
        // listener serving those controls (the React 17+ root, a jQuery .on()
        // container). A real clickable card nearly always also sets a pointer
        // cursor, which still reports it.
        const inner = firstTabbableInside(el);
        if (inner && signals.length === 1 && signals[0] === 'a click listener') continue;

        total++;
        if (findings.length >= CAP) continue;

        let details =
          `Mouse users can operate this element (${signals.join(', ')}), but it cannot get keyboard focus: ` +
          'it is not focusable and it is not inside a focusable element.';
        const ti = el.getAttribute('tabindex');
        if (ti !== null && el.tabIndex < 0) {
          details += ` Its tabindex="${ti}" takes it out of the Tab order.`;
        }
        details +=
          ' Trusted Tester 4.A (WCAG 2.1.1 Keyboard): look for another keyboard method on the page that does the same thing, ' +
          'for example a link or button with the same function. If there is none, this fails 2.1.1. ' +
          'To fix a custom control, use a native element, or add tabindex="0" and handle Enter and Space.';
        if (inner) {
          details += ` It contains a focusable element (${globalThis.__a11ySelector(inner)}); if that element does the same thing, this passes.`;
        }
        findings.push(
          F.makeFinding({ tool: 'keyboard-access', wcag: '2.1.1', severity: 'review', el, details })
        );
        if (globalThis.__a11yOverlay) {
          globalThis.__a11yOverlay.outline(el, 'review');
          globalThis.__a11yOverlay.badge(el, '4.A', 'review');
        }
      }

      if (total > CAP) {
        findings.push(
          F.makeFinding({
            tool: 'keyboard-access',
            wcag: '2.1.1',
            severity: 'review',
            el: null,
            details: `Found ${total} mouse-only candidates in this frame; only the first ${CAP} are listed.`,
          })
        );
      }
      return findings;
    };
  })();
}
