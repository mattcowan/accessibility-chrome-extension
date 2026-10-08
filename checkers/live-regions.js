// Live-region monitor ("expose aria-live"):
//   __a11yCheckers.liveRegions('start')  -> {active:true, count, findings}
//       Finds every live region (aria-live, role=status/log/alert, <output>),
//       attaches a visible on-page log panel next to each (green "polite" /
//       red "assertive" pill), and appends every announcement to that panel —
//       entries are never deleted, so the session can be exported as a log.
//       Also returns one review finding per region so the popup badge/report
//       machinery shows what is being monitored.
//   __a11yCheckers.liveRegions('stop')   -> {active:false}   (discards the log)
//   __a11yCheckers.liveRegions('status') -> {active, count}
//   __a11yCheckers.liveRegions('export') -> [{selector, politeness, role, message, timestamp}]
//       Log data lives in this closure (page-side), so it survives popup
//       close/reopen; export never depends on the panel DOM.
// Needs selector.js, findings.js and lib/live.js.
if (!globalThis.__a11yLiveRegions) {
  globalThis.__a11yLiveRegions = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const { REGION_SELECTOR, politenessFor } = globalThis.__a11yLive;
    const PANEL_CLASS = '__a11y-live-panel';
    const DOCK_ID = '__a11y-live-dock';
    const COLORS = { polite: '#15803d', assertive: '#b91c1c' };
    const DEDUPE_MS = 500;

    let active = false;
    let docObserver = null;
    // regionEl -> {selector, politeness, role, panel, logEl, entries, observer, lastMsg, lastTs}
    const regions = new Map();

    function ensureDock() {
      let dock = document.getElementById(DOCK_ID);
      if (!dock) {
        dock = document.createElement('div');
        dock.id = DOCK_ID;
        dock.setAttribute('aria-hidden', 'true');
        dock.style.cssText =
          'position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:490px;' +
          'max-height:45vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;';
        document.documentElement.appendChild(dock);
      }
      return dock;
    }

    function buildPanel(info) {
      const panel = document.createElement('div');
      panel.className = PANEL_CLASS;
      // aria-hidden: the panel mirrors announcements visually; without it every
      // message would be spoken twice by AT. pointer-events stay ON (users
      // scroll and copy the log) — deliberately unlike the findings overlay.
      panel.setAttribute('aria-hidden', 'true');
      panel.style.cssText =
        'all:initial;display:block;max-width:480px;margin:4px 0;border:1px solid #4b5563;' +
        'border-radius:6px;overflow:hidden;font:11px/1.5 ui-monospace,Consolas,monospace;' +
        'background:#1f2937;box-shadow:0 1px 4px rgba(0,0,0,.35);';

      const header = document.createElement('div');
      header.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:4px 8px;background:#111827;color:#e5e7eb;';
      const pill = document.createElement('span');
      pill.textContent = info.politeness;
      pill.style.cssText =
        'font-weight:700;font-size:10px;text-transform:uppercase;color:#fff;' +
        `padding:1px 7px;border-radius:9px;background:${COLORS[info.politeness]};`;
      const label = document.createElement('span');
      label.textContent = info.selector + (info.role ? ` (role=${info.role})` : '');
      label.style.cssText = 'overflow-wrap:anywhere;';
      header.append(pill, label);

      // The "stylized textarea": a scrollable monospace log that only grows.
      const logEl = document.createElement('div');
      logEl.style.cssText =
        'max-height:140px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;' +
        'background:#111827;color:#f9fafb;padding:6px 8px;user-select:text;cursor:text;';
      logEl.textContent = '(no announcements yet)';

      panel.append(header, logEl);
      return { panel, logEl, header };
    }

    function appendEntry(info, message) {
      const now = new Date();
      info.entries.push({ message, timestamp: now.toISOString() });
      if (info.entries.length === 1) info.logEl.textContent = '';
      const line = document.createElement('div');
      const hms =
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0') + '.' +
        String(now.getMilliseconds()).padStart(3, '0');
      line.textContent = `[${hms}] ${message}`;
      info.logEl.appendChild(line);
      info.logEl.scrollTop = info.logEl.scrollHeight;
      // A framework re-render may have evicted the panel; re-home it in the
      // fixed dock so the visible log is never lost.
      if (!info.panel.isConnected) ensureDock().appendChild(info.panel);
    }

    function messageFromRecords(el, records) {
      if ((el.getAttribute('aria-atomic') || '').toLowerCase() === 'true') {
        return el.textContent.trim();
      }
      const parts = [];
      for (const rec of records) {
        if (rec.type === 'characterData') {
          const t = (rec.target.data || '').trim();
          if (t) parts.push(t);
        } else if (rec.type === 'childList') {
          for (const n of rec.addedNodes) {
            const t = (n.textContent || '').trim();
            if (t) parts.push(t);
          }
        }
      }
      return [...new Set(parts)].join(' ').trim();
    }

    function track(el) {
      if (regions.has(el)) return null;
      if (el.closest && el.closest(`.${PANEL_CLASS}`)) return null;
      const politeness = politenessFor(el);
      if (!politeness) return null;

      const info = {
        el,
        selector: globalThis.__a11ySelector(el),
        politeness,
        role: (el.getAttribute('role') || '').toLowerCase() || (el.tagName === 'OUTPUT' ? 'status' : ''),
        entries: [],
        lastMsg: null,
        lastTs: 0,
        panel: null,
        logEl: null,
        header: null,
        observer: null,
      };
      Object.assign(info, buildPanel(info));

      try {
        el.insertAdjacentElement('afterend', info.panel);
      } catch {
        ensureDock().appendChild(info.panel);
      }
      if (!info.panel.isConnected) ensureDock().appendChild(info.panel);

      info.observer = new MutationObserver((records) => {
        const message = messageFromRecords(el, records);
        if (!message) return;
        const now = Date.now();
        // Frameworks often double-mutate; drop identical back-to-back messages.
        if (message === info.lastMsg && now - info.lastTs < DEDUPE_MS) return;
        info.lastMsg = message;
        info.lastTs = now;
        appendEntry(info, message);
      });
      info.observer.observe(el, { childList: true, characterData: true, subtree: true });

      regions.set(el, info);
      return info;
    }

    function markRemoved(info) {
      if (info.removed) return;
      info.removed = true;
      info.observer.disconnect();
      const note = document.createElement('span');
      note.textContent = ' (removed)';
      note.style.cssText = 'color:#9ca3af;';
      info.header.appendChild(note);
      if (!info.panel.isConnected) ensureDock().appendChild(info.panel);
    }

    function collectRegions(root) {
      const out = [];
      F.collectMatching(root, REGION_SELECTOR, out);
      return out;
    }

    function start() {
      if (active) return { active: true, count: regions.size, findings: [] };
      active = true;

      const findings = [];
      for (const el of collectRegions(document)) {
        const info = track(el);
        if (!info) continue;
        findings.push(
          F.makeFinding({
            tool: 'live-regions',
            wcag: '4.1.3',
            severity: 'review',
            el,
            details:
              `Live region (${info.politeness}${info.role ? `, role=${info.role}` : ''}) is being monitored. ` +
              'Trigger the UI updates this region serves and verify each announcement appears in the on-page log ' +
              'and conveys the status message without requiring focus (WCAG 4.1.3 Status Messages).',
          })
        );
      }

      // Watch for regions added after start. (Document-level observer — regions
      // added inside shadow roots after start are a known limitation; the
      // start-time scan does cover open shadow roots.)
      docObserver = new MutationObserver((records) => {
        for (const rec of records) {
          for (const n of rec.addedNodes) {
            if (n.nodeType !== Node.ELEMENT_NODE) continue;
            if (n.closest && n.closest(`.${PANEL_CLASS}`)) continue;
            if (n.classList && n.classList.contains(PANEL_CLASS)) continue;
            if (n.id === DOCK_ID) continue;
            if (n.matches && n.matches(REGION_SELECTOR)) track(n);
            if (n.querySelectorAll) {
              for (const el of n.querySelectorAll(REGION_SELECTOR)) track(el);
            }
          }
        }
        // Anything tracked that is no longer connected has been removed.
        for (const info of regions.values()) {
          if (!info.removed && !info.el.isConnected) markRemoved(info);
        }
      });
      docObserver.observe(document.documentElement, { childList: true, subtree: true });

      document.documentElement.dataset.a11yLiveMonitor = 'on';
      return { active: true, count: findings.length, findings };
    }

    function stop() {
      if (!active) return { active: false };
      active = false;
      if (docObserver) docObserver.disconnect();
      docObserver = null;
      for (const info of regions.values()) {
        info.observer.disconnect();
        info.panel.remove();
      }
      regions.clear();
      const dock = document.getElementById(DOCK_ID);
      if (dock) dock.remove();
      delete document.documentElement.dataset.a11yLiveMonitor;
      return { active: false };
    }

    function exportLog() {
      const rows = [];
      for (const info of regions.values()) {
        for (const e of info.entries) {
          rows.push({
            selector: info.selector,
            politeness: info.politeness,
            role: info.role,
            message: e.message,
            timestamp: e.timestamp,
          });
        }
      }
      rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      return rows;
    }

    globalThis.__a11yCheckers.liveRegions = function liveRegions(cmd) {
      if (cmd === 'start') return start();
      if (cmd === 'stop') return stop();
      if (cmd === 'export') return exportLog();
      return { active, count: regions.size };
    };
  })();
}
