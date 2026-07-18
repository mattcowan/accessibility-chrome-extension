// Content-on-hover/focus checker (WCAG 1.4.13), two passes:
//  - static:  __a11yCheckers.hoverStatic() -> {findings, candidates}
//             title-attribute triage (redundant / unique-info / only-label —
//             native title tooltips are exempt from 1.4.13, so these are
//             never graded fail) + CSSOM discovery of :hover/:focus
//             reveal rules (candidates for the dynamic pass).
//  - dynamic: driven by the popup, which asks the service worker to send
//             REAL CDP mouse-moves (CSS :hover cannot be faked from JS):
//             __a11yHover.prepare(i) -> coords / focuses trigger
//             __a11yHover.observe(i) -> did hidden content appear?
//             (popup sends Escape via CDP)
//             __a11yHover.verdict(i) -> dismissed? -> finding
//             __a11yHover.finish(i)  -> cleanup
if (!globalThis.__a11yHoverContent) {
  globalThis.__a11yHoverContent = true;

  globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

  (function () {
    const F = globalThis.__a11yFindings;
    const MAX_CANDIDATES = 30;
    const REVEAL_DISPLAY = /^(?!none)/;

    function hidden(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (parseFloat(cs.opacity) === 0) return true;
      const rect = el.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0;
    }

    function isRevealRule(style) {
      const d = style.getPropertyValue('display');
      const v = style.getPropertyValue('visibility');
      const o = style.getPropertyValue('opacity');
      return (
        (d && d !== 'none' && REVEAL_DISPLAY.test(d)) ||
        v === 'visible' ||
        (o !== '' && parseFloat(o) > 0)
      );
    }

    function collectRevealRules() {
      const out = [];
      function walk(list) {
        for (const rule of list) {
          try {
            if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
            if (rule.cssRules && !rule.selectorText) {
              walk(rule.cssRules);
              continue;
            }
            const sel = rule.selectorText;
            if (!sel || !(sel.includes(':hover') || sel.includes(':focus'))) continue;
            if (!isRevealRule(rule.style)) continue;
            for (const part of sel.split(',')) {
              const kind = part.includes(':hover') ? 'hover' : part.includes(':focus') ? 'focus' : null;
              if (!kind) continue;
              const pseudo = kind === 'hover' ? ':hover' : /:focus-within|:focus-visible|:focus/;
              const idx = part.search(pseudo);
              if (idx <= 0) continue;
              const trigger = part.slice(0, idx).trim();
              const target = part.replace(/:hover|:focus-within|:focus-visible|:focus/g, '').trim();
              if (!trigger || !target) continue;
              out.push({ trigger, target, kind });
            }
          } catch {
            // unreadable rule
          }
        }
      }
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules);
        } catch {
          // cross-origin sheet — skipped (noted in checker docs)
        }
      }
      return out;
    }

    function buildCandidates() {
      const byTrigger = new Map();
      for (const rule of collectRevealRules()) {
        let triggers;
        let targets;
        try {
          triggers = document.querySelectorAll(rule.trigger);
          targets = document.querySelectorAll(rule.target);
        } catch {
          continue;
        }
        const hiddenTargets = Array.from(targets).filter(hidden);
        if (!hiddenTargets.length) continue;
        for (const trigger of triggers) {
          if (hidden(trigger)) continue;
          // Prefer targets inside the trigger (descendant tooltips/menus);
          // fall back to all rule targets for sibling-combinator patterns.
          const own = hiddenTargets.filter((t) => trigger.contains(t));
          const entry = byTrigger.get(trigger) || { trigger, targets: new Set(), kind: rule.kind };
          (own.length ? own : hiddenTargets).forEach((t) => entry.targets.add(t));
          if (rule.kind === 'hover') entry.kind = 'hover';
          byTrigger.set(trigger, entry);
        }
        if (byTrigger.size >= MAX_CANDIDATES) break;
      }
      return Array.from(byTrigger.values())
        .slice(0, MAX_CANDIDATES)
        .map((c) => ({ trigger: c.trigger, targets: Array.from(c.targets), kind: c.kind }));
    }

    // Native title tooltips are NOT a 1.4.13 failure — the SC exempts content
    // whose presentation is user-agent-controlled. What matters is whether the
    // title text is redundant (best-practice removal), carries information the
    // visible text lacks (2.4.4 / 1.3.1, human must verify), or is the field's
    // only label (3.3.2). Author-built tooltips are the dynamic pass's job.
    globalThis.__a11yCheckers.hoverStatic = function hoverStatic() {
      const findings = [];
      const A = globalThis.__a11yAccname;
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const titled = [];
      F.collectMatching(document, '[title]', titled);
      for (const el of titled) {
        const title = norm(el.getAttribute('title'));
        if (!title) continue;
        const tag = el.tagName;
        // <iframe title> is the frame's required accessible name, not a
        // tooltip pattern — nothing to flag.
        if (tag === 'IFRAME') continue;
        const acc = A.compute(el);
        if (acc.source === 'title' && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
          findings.push(
            F.makeFinding({
              tool: 'hover-content',
              wcag: '3.3.2',
              severity: 'review',
              el,
              details: `The title attribute is this <${tag.toLowerCase()}>'s only accessible name. Screen readers announce it, but sighted users get no visible label, and 3.3.2 requires labels or instructions where content requires input. Verify a visible label exists, or add a <label>.`,
            })
          );
          continue;
        }
        const nameN = norm(acc.source === 'title' ? '' : acc.name);
        const textN = norm(el.textContent);
        const redundant =
          (nameN && (nameN === title || nameN.includes(title))) ||
          (textN && (textN === title || textN.includes(title)));
        if (redundant) {
          findings.push(
            F.makeFinding({
              tool: 'hover-content',
              wcag: 'best-practice',
              severity: 'warn',
              el,
              details: 'The title attribute duplicates the visible text: it adds no information, and some screen-reader configurations announce it twice. Remove it. (Native title tooltips are exempt from 1.4.13 — their presentation is user-agent-controlled.)',
            })
          );
        } else {
          const isLink = (tag === 'A' || tag === 'AREA') && el.hasAttribute('href');
          findings.push(
            F.makeFinding({
              tool: 'hover-content',
              wcag: isLink ? '2.4.4' : '1.3.1',
              severity: 'review',
              el,
              details: `The title attribute carries text not present in the ${
                isLink ? 'link text — link purpose must be determinable from it (2.4.4)' : 'visible text (1.3.1: information must not depend on one presentation channel)'
              }. The native tooltip is exempt from 1.4.13 (user-agent-controlled), but it never appears for touch users or sighted keyboard users. Verify the information is available elsewhere; if not, move it into visible or visually-hidden text and remove the title.`,
            })
          );
        }
      }

      const candidates = buildCandidates();
      globalThis.__a11yHover = makeDynamicApi(candidates);
      return {
        findings,
        candidates: candidates.map((c, i) => ({
          index: i,
          kind: c.kind,
          trigger: globalThis.__a11ySelector(c.trigger),
        })),
      };
    };

    function makeDynamicApi(candidates) {
      const snapshots = new Map();
      return {
        prepare(i) {
          const c = candidates[i];
          if (!c) return { ok: false };
          c.trigger.scrollIntoView({ block: 'center', inline: 'center' });
          snapshots.set(i, c.targets.map(hidden));
          if (c.kind === 'focus') {
            try {
              c.trigger.focus({ preventScroll: true });
            } catch {
              // not focusable — the :focus rule can't trigger for users either
            }
            return { ok: true, kind: 'focus' };
          }
          const rect = c.trigger.getBoundingClientRect();
          return {
            ok: true,
            kind: 'hover',
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        },
        observe(i) {
          const c = candidates[i];
          const before = snapshots.get(i) || [];
          const revealed = c.targets.filter((t, idx) => before[idx] && !hidden(t));
          return { revealed: revealed.length > 0 };
        },
        verdict(i) {
          const c = candidates[i];
          const stillVisible = c.targets.filter((t) => !hidden(t));
          if (!stillVisible.length) return { finding: null };
          return {
            finding: F.makeFinding({
              tool: 'hover-content',
              wcag: '1.4.13',
              severity: 'fail',
              el: c.trigger,
              details: `Content revealed on ${c.kind} is not dismissible with Escape while the ${
                c.kind === 'hover' ? 'pointer stays on the trigger' : 'trigger keeps focus'
              } — fails the 1.4.13 dismissible requirement. Revealed: ${stillVisible
                .map((t) => globalThis.__a11ySelector(t))
                .join('; ')}`,
            }),
          };
        },
        finish(i) {
          const c = candidates[i];
          if (c && c.kind === 'focus' && document.activeElement === c.trigger) {
            c.trigger.blur();
          }
        },
      };
    }
  })();
}
