// Accessible-name inspector:
//   __a11yCheckers.accnameInspector('start') -> {active:true, findings}
//       Batch-scans interactive elements for empty accessible names (findings)
//       AND enters hover-to-inspect mode: a tooltip follows the mouse showing
//       role / name / name source / description. Escape exits the mode.
//   __a11yCheckers.accnameInspector('stop')  -> {active:false}
if (!globalThis.__a11yAccnameInspector) {
  globalThis.__a11yAccnameInspector = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const A = globalThis.__a11yAccname;
    const TIP_ID = '__a11y-accname-tip';
    let cleanup = null;

    function scanEmptyNames() {
      const findings = [];
      for (const el of F.collectInteractive(document)) {
        // Inputs typed by their container label, generic tabindex hosts etc.
        // still need a name; skip plain [onclick] containers with text.
        const { name, role } = A.compute(el);
        if (name) continue;
        if (!['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'option', 'img'].includes(role)) {
          continue;
        }
        findings.push(
          F.makeFinding({
            tool: 'accname',
            wcag: '4.1.2',
            severity: 'fail',
            el,
            details: `Interactive element (role: ${role}) has an empty accessible name — screen reader users hear nothing useful. Add visible text, aria-label, alt, or a <label>.`,
          })
        );
      }
      return findings;
    }

    function startInspector() {
      if (cleanup) return;
      const tip = document.createElement('div');
      tip.id = TIP_ID;
      tip.setAttribute('aria-hidden', 'true');
      tip.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;max-width:320px;' +
        'background:#111827;color:#f9fafb;font:12px/1.45 system-ui,sans-serif;' +
        'padding:8px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.5);' +
        'display:none;white-space:pre-wrap;';
      document.documentElement.appendChild(tip);

      const highlight = document.createElement('div');
      highlight.setAttribute('aria-hidden', 'true');
      highlight.style.cssText =
        'position:absolute;z-index:2147483646;pointer-events:none;' +
        'outline:2px solid #0f766e;outline-offset:1px;display:none;';
      document.documentElement.appendChild(highlight);

      function onMove(e) {
        const el = e.target;
        if (!el || el === tip || el.nodeType !== Node.ELEMENT_NODE) return;
        const info = A.compute(el);
        const desc = A.describe(el);
        tip.textContent =
          `role: ${info.role}\n` +
          `name: ${info.name || '(empty)'}${info.name ? '' : ' ⚠'}\n` +
          `source: ${info.source}` +
          (desc ? `\ndescription: ${desc}` : '');
        tip.style.display = 'block';
        const x = Math.min(e.clientX + 14, window.innerWidth - 340);
        const y = Math.min(e.clientY + 18, window.innerHeight - 90);
        tip.style.left = `${Math.max(0, x)}px`;
        tip.style.top = `${Math.max(0, y)}px`;

        const rect = el.getBoundingClientRect();
        highlight.style.display = 'block';
        highlight.style.top = `${rect.top + window.scrollY}px`;
        highlight.style.left = `${rect.left + window.scrollX}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
      }

      function onKey(e) {
        if (e.key === 'Escape') stopInspector();
      }

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('keydown', onKey, true);
      cleanup = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('keydown', onKey, true);
        tip.remove();
        highlight.remove();
        cleanup = null;
      };
    }

    function stopInspector() {
      if (cleanup) cleanup();
    }

    globalThis.__a11yCheckers.accnameInspector = function accnameInspector(cmd) {
      if (cmd === 'start') {
        const findings = scanEmptyNames();
        startInspector();
        return { active: true, findings };
      }
      stopInspector();
      return { active: false };
    };
  })();
}
