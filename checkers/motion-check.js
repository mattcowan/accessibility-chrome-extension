// Motion-respect checker (WCAG 2.3.3 Animation from Interactions / 2.2.2
// Pause, Stop, Hide). Injected (classic script) after selector.js,
// findings.js, accname.js and mechanism.js via chrome.scripting.executeScript
// files[]. Registers itself on globalThis.__a11yCheckers; does no scanning at
// injection time.
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

  // Video only: <audio> has no moving content, so it is not a 2.2.2 case —
  // auto-playing sound is WCAG 1.4.2, reported by the audio checker.
  const { find, describe } = globalThis.__a11yMechanism;
  const videos = [];
  collectMatching(document, 'video', videos);
  for (const el of videos) {
    if (!(el.autoplay || !el.paused)) continue;
    const m = find(el, '2.B');
    let severity;
    let details;
    if (m && m.where !== 'elsewhere') {
      severity = 'review';
      details =
        `Auto-playing video has a candidate mechanism to pause, stop, or hide it. ${describe(m)} ` +
        'Activate it and confirm the video stops. WCAG 2.2.2 / Trusted Tester 2.B apply when the motion lasts more than 5 seconds.';
    } else if (m) {
      severity = 'warn';
      details =
        `Auto-playing video has a candidate pause control, but not where Trusted Tester 2.B expects it: within the first three elements, or within three elements before or after the video. ${describe(m)} ` +
        'Verify that the control stops the video and that a user can find it.';
    } else {
      severity = 'fail';
      details =
        'Auto-playing video has no mechanism to pause, stop, or hide it (WCAG 2.2.2). No native controls, no control named pause/stop/play/hide/freeze, and no control with aria-controls pointing at the video was found.';
    }
    findings.push(makeFinding({ tool: 'motion', wcag: '2.2.2', severity, el, details }));
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
