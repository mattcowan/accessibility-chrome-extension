// Input watcher (WCAG 3.2.2 / Trusted Tester 5.D, and 4.1.2 / TT 5.E): while
// the tester changes form fields by hand, log what each field's `input`,
// `change` or blur caused.
//   __a11yCheckers.inputWatcher('start')  -> {active:true}
//   __a11yCheckers.inputWatcher('stop')   -> {active:false}  (removes everything)
//   __a11yCheckers.inputWatcher('status') -> {active}
// Needs selector.js, findings.js, accname.js, lib/forms.js and lib/live.js.
// Top frame only.
//
// It only watches: it never types, selects, clicks or submits, and it never
// attaches the debugger.
//
// The log is not kept here. A navigation ends this script, so every entry
// goes to the service worker, which keeps the log in chrome.storage.session
// (`watch:${tabId}`) and the popup turns it into findings:
//   {type:'inputWatch', action:'mark'}   a field changed (the SW logs a
//                                        navigation or new tab that follows)
//   {type:'inputWatch', action:'unmark'} the user clicked something else or
//                                        pressed Enter (what follows is theirs)
//   {type:'inputWatch', action:'event'}  an effect seen here: a script focus
//                                        move, content shown, a form submit
// An effect window opens on a field's input/change (and on its blur after a
// change) and closes EFFECT_MS after the last field event. Content counts as
// shown when an element that was not rendered when the field got focus is
// rendered at the window's end, or an element added in the window is.
//
// The documentElement carries data-a11y-input-watcher="on" (popup re-sync).
if (!globalThis.__a11yInputWatcher) {
  globalThis.__a11yInputWatcher = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const A = globalThis.__a11yAccname;
    const Fo = globalThis.__a11yForms;
    const L = globalThis.__a11yLive;
    const EFFECT_MS = 1000; // window after the last field event
    const MAX_WINDOW_MS = 4000;
    const USER_MS = 150; // a focus move this soon after a Tab key or a click is the user's
    const MARK_MS = 5000; // same as the SW's navigation window
    const HIDDEN_CAP = 5000;
    // Keys whose default action moves focus (radio groups move with arrows).
    const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    const SUBMIT_SELECTOR = 'button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]';

    let active = false;
    let observer = null;
    let hidden = []; // elements not rendered at the last snapshot
    let win = null;
    let dirty = new WeakSet(); // fields changed since they got focus
    let lastKeyNav = 0;
    let lastPointer = 0;
    let pointerTarget = null;
    let lastExplicit = 0; // Enter or a click on a submit button
    let markAt = 0;

    const now = () => performance.now();
    const pathTarget = (e) => {
      const t = e.composedPath()[0];
      return t && t.nodeType === Node.ELEMENT_NODE ? t : null;
    };

    function post(msg) {
      try {
        chrome.runtime.sendMessage({ type: 'inputWatch', ...msg }).catch(() => {});
      } catch {
        // extension reloaded — nothing to tell
      }
    }

    function describe(el) {
      return {
        selector: globalThis.__a11ySelector(el),
        snippet: globalThis.__a11yFindings.snippet(el),
        name: A.compute(el).name,
        url: location.href,
      };
    }

    function snapshotHidden() {
      const out = [];
      const all = document.body ? document.body.getElementsByTagName('*') : [];
      for (let i = 0; i < all.length && out.length < HIDDEN_CAP; i++) {
        const el = all[i];
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|BR)$/.test(el.tagName) || Fo.isTool(el)) continue;
        if (!Fo.rendered(el)) out.push(el);
      }
      hidden = out;
    }

    // Keep only the outermost of a set of elements.
    function outermost(list) {
      return list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
    }

    const hasContent = (el) => !!(Fo.textOf(el) || el.querySelector(Fo.FIELD_SELECTOR) || el.matches('img, video, iframe'));

    function isUserFocus(t) {
      const n = now();
      if (n - lastKeyNav < USER_MS) return true;
      if (n - lastPointer < 1000 && pointerTarget) {
        if (pointerTarget === t || t.contains(pointerTarget)) return true;
        const label = pointerTarget.closest && pointerTarget.closest('label');
        if (label && label.control === t) return true;
      }
      return false;
    }

    // ------------------------------------------------------------- windows

    function openWindow(field, kind) {
      if (win && win.field !== field) closeWindow();
      if (!win) {
        win = { field, kinds: new Set(), start: now(), added: [], regions: new Set(), focusMoves: [], submitted: false, timer: 0 };
      }
      win.kinds.add(kind);
      clearTimeout(win.timer);
      const wait = Math.max(0, Math.min(EFFECT_MS, MAX_WINDOW_MS - (now() - win.start)));
      win.timer = setTimeout(closeWindow, wait);
    }

    function closeWindow() {
      const w = win;
      win = null;
      if (!w) return;
      clearTimeout(w.timer);
      if (!active) return;
      const field = w.field.isConnected ? describe(w.field) : null;
      if (!field) {
        snapshotHidden();
        return;
      }
      const cause = [...w.kinds].join('/');

      for (const target of w.focusMoves) {
        post({ action: 'event', event: { kind: 'focus', cause, field, target: describe(target) } });
      }
      if (w.submitted) post({ action: 'event', event: { kind: 'submit', cause, field } });

      const shown = outermost(
        [...hidden.filter((el) => el.isConnected && Fo.rendered(el)), ...w.added.filter((el) => el.isConnected && Fo.rendered(el))].filter(
          (el) => !el.contains(w.field) && !w.field.contains(el) && !Fo.isTool(el) && hasContent(el)
        )
      );
      // Live regions that changed in the window (any of them may be what
      // tells the user; the tester judges).
      const announced = [...w.regions].map((r) => Fo.textOf(r)).filter(Boolean).slice(0, 3);
      for (const el of shown.slice(0, 5)) {
        const focusIn = w.focusMoves.some((t) => el.contains(t)) || el.contains(document.activeElement);
        post({
          action: 'event',
          event: {
            kind: 'content',
            cause,
            field,
            target: { ...describe(el), text: Fo.textOf(el).slice(0, 120) },
            focusMoved: focusIn,
            announced,
          },
        });
      }
      snapshotHidden();
    }

    // -------------------------------------------------------------- events

    function onKeydown(e) {
      if (NAV_KEYS.has(e.key)) lastKeyNav = now();
      if (e.key === 'Enter') {
        lastExplicit = now();
        unmark();
      }
    }

    function unmark() {
      if (now() - markAt < MARK_MS) {
        markAt = 0;
        post({ action: 'unmark' });
      }
    }

    function onPointer(e) {
      lastPointer = now();
      pointerTarget = pathTarget(e);
      if (!pointerTarget) return;
      if (pointerTarget.closest(SUBMIT_SELECTOR)) lastExplicit = now();
      // A click on anything but a field (or its label) is the user's own
      // action: a navigation or new tab after it is not the field's.
      const label = pointerTarget.closest('label');
      if (!Fo.isField(pointerTarget) && !(label && label.control)) unmark();
    }

    function onFocusIn(e) {
      const t = pathTarget(e);
      if (!t) return;
      if (win && t !== win.field && !isUserFocus(t)) win.focusMoves.push(t);
      if (Fo.isField(t)) {
        dirty.delete(t);
        // The "before" picture for content the next change shows.
        if (!win) snapshotHidden();
      }
    }

    function onFocusOut(e) {
      const t = pathTarget(e);
      if (!t || !Fo.isField(t)) return;
      if (win && win.field === t) openWindow(t, 'blur');
      else if (dirty.has(t)) openWindow(t, 'blur');
    }

    function onFieldEvent(e) {
      const t = pathTarget(e);
      if (!t || !Fo.isField(t)) return;
      dirty.add(t);
      openWindow(t, e.type);
      markAt = now();
      post({ action: 'mark', field: describe(t), cause: e.type });
    }

    function onSubmit() {
      // Enter or a submit-button click is the user's own submit.
      if (win && now() - lastExplicit > 500) win.submitted = true;
    }

    function onMutations(records) {
      if (!win) return;
      for (const rec of records) {
        const region = L.regionOf(rec.target);
        if (region && !Fo.isTool(region)) win.regions.add(region);
        if (rec.type !== 'childList') continue;
        for (const n of rec.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE || Fo.isTool(n)) continue;
          win.added.push(n);
          const r = L.regionOf(n);
          if (r && !Fo.isTool(r)) win.regions.add(r);
        }
      }
    }

    // --------------------------------------------------------- start / stop

    const LISTENERS = [
      ['keydown', onKeydown],
      ['pointerdown', onPointer],
      ['mousedown', onPointer],
      ['focusin', onFocusIn],
      ['focusout', onFocusOut],
      ['input', onFieldEvent],
      ['change', onFieldEvent],
      ['submit', onSubmit],
    ];

    function start() {
      if (active) return { active: true };
      active = true;
      snapshotHidden();
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      for (const [type, fn] of LISTENERS) document.addEventListener(type, fn, true);
      document.documentElement.dataset.a11yInputWatcher = 'on';
      return { active: true };
    }

    function stop() {
      if (!active) return { active: false };
      // Report what the open window has seen so far before stopping.
      if (win) closeWindow();
      active = false;
      if (observer) observer.disconnect();
      observer = null;
      for (const [type, fn] of LISTENERS) document.removeEventListener(type, fn, true);
      hidden = [];
      dirty = new WeakSet();
      pointerTarget = null;
      markAt = 0;
      delete document.documentElement.dataset.a11yInputWatcher;
      return { active: false };
    }

    globalThis.__a11yCheckers.inputWatcher = function inputWatcher(cmd) {
      if (cmd === 'start') return start();
      if (cmd === 'stop') return stop();
      return { active };
    };

  })();
}
