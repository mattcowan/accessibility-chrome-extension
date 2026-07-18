// Motion-respect checker (WCAG 2.3.3 Animation from Interactions / 2.2.2
// Pause, Stop, Hide). Injected (classic script) after selector.js and
// findings.js via chrome.scripting.executeScript files[]. Registers itself
// on globalThis.__a11yCheckers; does no scanning at injection time.
globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

globalThis.__a11yCheckers.motion = function motion() {
  const { makeFinding, collectMatching } = globalThis.__a11yFindings;
  const findings = [];

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    findings.unshift(
      makeFinding({
        tool: 'motion',
        wcag: '2.3.3',
        severity: 'review',
        el: null,
        details:
          'Reduced-motion emulation is not active; results reflect the default preference. Enable the Reduced motion toggle and re-run.',
      })
    );
  }

  function walkShadowAnimations(root, anims) {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      for (const child of el.shadowRoot.querySelectorAll('*')) {
        for (const a of child.getAnimations({ subtree: false })) anims.add(a);
      }
      walkShadowAnimations(el.shadowRoot, anims);
    }
  }

  const animations = new Set(document.getAnimations());
  walkShadowAnimations(document, animations);

  const targets = new Map(); // target el -> { severity, entries: [{name, duration, iterations}] }
  for (const anim of animations) {
    if (anim.playState !== 'running') continue;
    const effect = anim.effect;
    const target = effect && effect.target;
    if (!target) continue;
    const timing = effect.getTiming();
    const duration = timing.duration === 'auto' ? 0 : Number(timing.duration) || 0;
    const iterations = timing.iterations;
    const infinite = iterations === Infinity;
    const total = infinite ? Infinity : duration * iterations;
    if (total <= 100 && !infinite) continue;

    const severity = infinite || total > 5000 ? 'fail' : 'warn';
    const name = anim.animationName || anim.constructor.name;
    const rec = targets.get(target) || { severity: 'warn', entries: [] };
    if (severity === 'fail') rec.severity = 'fail';
    rec.entries.push({ name, duration, iterations: infinite ? 'infinite' : iterations });
    targets.set(target, rec);
  }

  for (const [el, rec] of targets) {
    const list = rec.entries
      .map((e) => `${e.name} (duration=${e.duration}ms, iterations=${e.iterations})`)
      .join('; ');
    const details =
      rec.severity === 'fail'
        ? `${rec.entries.length} animation(s) keep running under prefers-reduced-motion: ${list}.`
        : `${rec.entries.length} short finite animation(s) still running under reduced-motion: ${list}. Likely acceptable but verify — WCAG 2.2.2 applies over 5s.`;
    findings.push(makeFinding({ tool: 'motion', wcag: '2.3.3', severity: rec.severity, el, details }));
  }

  const media = [];
  collectMatching(document, 'video, audio', media);
  for (const el of media) {
    if (!(el.autoplay || !el.paused)) continue;
    const noControls = !el.paused && !el.controls;
    const loopingNoControls = el.autoplay && el.loop && !el.controls;
    if (noControls || loopingNoControls) {
      findings.push(
        makeFinding({
          tool: 'motion',
          wcag: '2.2.2',
          severity: 'fail',
          el,
          details: 'Media autoplays/loops with no visible controls; no mechanism to pause, stop, or hide it.',
        })
      );
    } else if (el.autoplay) {
      findings.push(
        makeFinding({
          tool: 'motion',
          wcag: '2.2.2',
          severity: 'warn',
          el,
          details: 'Autoplaying media — verify a pause/stop control exists and it stops within 5 seconds.',
        })
      );
    }
  }

  const marquees = [];
  collectMatching(document, 'marquee', marquees);
  for (const el of marquees) {
    findings.push(
      makeFinding({
        tool: 'motion',
        wcag: '2.2.2',
        severity: 'review',
        el,
        details: '<marquee> produces moving content with no built-in pause control.',
      })
    );
  }

  const timelineCandidates = new Set(targets.keys());
  const styleMatches = [];
  collectMatching(document, '[style*="animation-timeline"]', styleMatches);
  for (const el of styleMatches) timelineCandidates.add(el);
  for (const el of timelineCandidates) {
    try {
      const value = getComputedStyle(el).animationTimeline;
      // 'auto' is the computed value for ordinary time-driven animations.
      if (value && value !== 'none' && value !== 'auto') {
        findings.push(
          makeFinding({
            tool: 'motion',
            wcag: '2.3.3',
            severity: 'review',
            el,
            details: `Scroll-driven animation (animation-timeline: ${value}) may not respect the reduced-motion preference.`,
          })
        );
      }
    } catch {
      // animation-timeline unsupported in this browser; skip.
    }
  }

  return findings;
};
